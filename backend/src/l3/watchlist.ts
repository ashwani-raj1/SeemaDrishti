import { all, one, run, bool, int } from "../db";
import { id, nowIso } from "../core/ids";
import { type Severity } from "../core/types";
import { recordAction } from "./audit";
import { publish } from "../l4/bus";
import { recordEvent } from "./events";

export interface WatchlistEntry {
  id: string;
  org_id: string;
  plate_number: string;
  vehicle_type: string;
  make_model: string | null;
  color: string | null;
  severity: Severity;
  flag_reason: string;
  notes: string | null;
  active: boolean;
  added_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlateDetection {
  id: string;
  org_id: string;
  camera_id: string;
  camera_name?: string;
  zone_id: string | null;
  zone_name?: string;
  plate_number: string;
  vehicle_type: string;
  confidence: number;
  plate_confidence: number;
  matched_watchlist_id: string | null;
  matched_entry?: WatchlistEntry | null;
  match_status: "MATCHED" | "CLEAR" | "UNVERIFIED";
  severity: Severity;
  bbox: [number, number, number, number];
  plate_bbox: [number, number, number, number];
  image_snapshot: string | null;
  simulated: boolean;
  plate_verified: boolean;
  occurred_at: string;
  created_at: string;
}

export interface WatchlistStats {
  totalWatchlist: number;
  activeWatchlist: number;
  criticalCount: number;
  warningCount: number;
  scans24h: number;
  matches24h: number;
  readRate: number;
}

export interface VehicleTrafficPoint {
  date: string;
  total: number;
}

export interface VehicleTrafficSummary {
  days: number;
  total: number;
  points: VehicleTrafficPoint[];
  byCamera: Record<string, number>;
  byType: Record<string, number>;
}

const DEFAULT_PLATE_DETECTION_RETENTION_DAYS = 15;
const PLATE_DETECTION_PURGE_INTERVAL_MS = 60 * 60 * 1000;
const lastPlateDetectionPurgeAt = new Map<string, number>();

/**
 * Keep ANPR history for 15 days. The lightweight hourly guard avoids running
 * the cleanup statement for every frame while still applying retention during
 * normal reads and detection ingestion.
 */
export function purgeExpiredPlateDetections(orgId: string, force = false): void {
  const now = Date.now();
  const lastPurge = lastPlateDetectionPurgeAt.get(orgId) ?? 0;
  if (!force && now - lastPurge < PLATE_DETECTION_PURGE_INTERVAL_MS) return;

  const organisation = one<{ retention_days: number }>(
    "SELECT retention_days FROM organisation WHERE id = $org",
    { $org: orgId },
  );
  const configuredDays = Number(organisation?.retention_days);
  const retentionDays = Number.isFinite(configuredDays) && configuredDays > 0
    ? Math.floor(configuredDays)
    : DEFAULT_PLATE_DETECTION_RETENTION_DAYS;
  const cutoff = new Date(now - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  run("DELETE FROM plate_detection WHERE org_id = $org AND occurred_at < $cutoff", {
    $org: orgId,
    $cutoff: cutoff,
  });
  lastPlateDetectionPurgeAt.set(orgId, now);
}

export interface CreateWatchlistInput {
  orgId: string;
  plateNumber: string;
  vehicleType?: string;
  makeModel?: string | null;
  color?: string | null;
  severity?: Severity;
  flagReason: string;
  notes?: string | null;
  active?: boolean;
}

export interface Actor {
  id: string;
  name: string;
  role: "operator" | "supervisor" | "admin";
}

// ------------------------------------------------------------------ OCR & Plate Formatting

/** Clean and normalize plate strings for comparison (removes spaces, dashes, punctuation). */
export function normalizePlate(raw: string): string {
  return (raw || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .trim();
}

/** Pretty format an Indian vehicle registration plate (e.g. PB02AK4821 -> PB 02 AK 4821). */
export function formatPlate(raw: string): string {
  const norm = normalizePlate(raw);
  if (!norm) return raw;
  // Match standard Indian format: 2-letter State, 1-2 digit District, optional 1-3 letter Series, 1-4 digit Number
  const match = norm.match(/^([A-Z]{2})(\d{1,2})([A-Z]{1,3})?(\d{1,4})$/);
  if (match) {
    const [, state, dist, series, num] = match;
    // dist and state are non-optional capture groups (no `?`), so match
    // succeeding guarantees both are present -- TS's regex typing is just
    // conservative here, not flagging a real gap.
    const paddedDist = dist!.padStart(2, "0");
    return `${state} ${paddedDist}${series ? ` ${series}` : ""} ${num}`;
  }
  return norm;
}

/** Check if two plates match, allowing for common OCR character substitutions. */
export function platesMatch(plateA: string, plateB: string): { match: boolean; confidence: number; exact: boolean } {
  const a = normalizePlate(plateA);
  const b = normalizePlate(plateB);

  if (!a || !b) return { match: false, confidence: 0, exact: false };
  if (a === b) return { match: true, confidence: 1.0, exact: true };

  // Common OCR confusion map
  const ocrSimilar: Record<string, string[]> = {
    "0": ["O", "Q", "D"],
    "O": ["0", "Q", "D"],
    "1": ["I", "T", "L"],
    "I": ["1", "T", "L"],
    "8": ["B", "3"],
    "B": ["8"],
    "5": ["S"],
    "S": ["5"],
    "2": ["Z"],
    "Z": ["2"],
  };

  // A missing character is not an OCR substitution. Treating a fragment as a
  // watchlist hit is unsafe because many different registrations share it.
  if (a.length !== b.length) return { match: false, confidence: 0, exact: false };

  let mismatches = 0;
  let ocrSubstitutions = 0;

  for (let i = 0; i < a.length; i++) {
    const charA = a[i];
    const charB = b[i];
    if (charA === charB) continue;

    // charA/charB are always defined -- i stays under a.length === b.length
    // (checked above) throughout this loop; TS's string index typing is
    // just conservative, not flagging a real out-of-bounds risk.
    if (ocrSimilar[charA!]?.includes(charB!) || ocrSimilar[charB!]?.includes(charA!)) {
      ocrSubstitutions++;
    } else {
      mismatches++;
    }
  }

  // One common glyph confusion can be recovered after OCR confirmation. Two
  // substitutions create too many plausible registrations for an alarm.
  if (mismatches === 0 && ocrSubstitutions === 1) {
    const score = 1.0 - ocrSubstitutions * 0.08;
    return { match: true, confidence: Math.max(0.84, score), exact: false };
  }

  return { match: false, confidence: 0, exact: false };
}

// ------------------------------------------------------------------ Watchlist Queries

export function listWatchlist(
  orgId: string,
  options: { search?: string; severity?: string; activeOnly?: boolean; limit?: number; offset?: number } = {},
): WatchlistEntry[] {
  let sql = "SELECT * FROM watchlist_entry WHERE org_id = $org";
  const params: Record<string, any> = { $org: orgId };

  if (options.activeOnly) {
    sql += " AND active = 1";
  }

  if (options.severity) {
    sql += " AND severity = $severity";
    params.$severity = options.severity;
  }

  if (options.search) {
    const term = `%${options.search.trim()}%`;
    sql += " AND (plate_number LIKE $search OR make_model LIKE $search OR flag_reason LIKE $search OR notes LIKE $search)";
    params.$search = term;
  }

  sql += " ORDER BY CASE severity WHEN 'CRITICAL' THEN 1 WHEN 'WARNING' THEN 2 ELSE 3 END, updated_at DESC";

  if (options.limit) {
    sql += ` LIMIT ${Number(options.limit)}`;
    if (options.offset) {
      sql += ` OFFSET ${Number(options.offset)}`;
    }
  }

  const rows = all<any>(sql, params);
  return rows.map(shapeWatchlistEntry);
}

export function getWatchlistEntry(id: string): WatchlistEntry | null {
  const row = one<any>("SELECT * FROM watchlist_entry WHERE id = $id", { $id: id });
  return row ? shapeWatchlistEntry(row) : null;
}

export function findWatchlistMatch(
  orgId: string,
  plateNumber: string,
  options: { allowFuzzy?: boolean } = {},
): { entry: WatchlistEntry; score: number; exact: boolean } | null {
  const activeEntries = listWatchlist(orgId, { activeOnly: true });
  const cleaned = normalizePlate(plateNumber);

  for (const entry of activeEntries) {
    const check = platesMatch(cleaned, entry.plate_number);
    if (check.match && (check.exact || options.allowFuzzy !== false)) {
      return { entry, score: check.confidence, exact: check.exact };
    }
  }

  return null;
}

export function createWatchlistEntry(input: CreateWatchlistInput, actor: Actor): WatchlistEntry {
  const at = nowIso();
  const entryId = id("wl");
  const formatted = formatPlate(input.plateNumber);

  const severity = input.severity ?? "WARNING";
  const active = input.active !== false;

  run(
    `INSERT INTO watchlist_entry
       (id, org_id, plate_number, vehicle_type, make_model, color, severity, flag_reason, notes, active, added_by, created_at, updated_at)
     VALUES ($id, $org, $plate, $type, $make, $color, $severity, $reason, $notes, $active, $added_by, $at, $at)`,
    {
      $id: entryId,
      $org: input.orgId,
      $plate: formatted,
      $type: input.vehicleType ?? "car",
      $make: input.makeModel ?? null,
      $color: input.color ?? null,
      $severity: severity,
      $reason: input.flagReason,
      $notes: input.notes ?? null,
      $active: int(active),
      $added_by: actor.name,
      $at: at,
    },
  );

  const created = getWatchlistEntry(entryId)!;

  recordAction({
    actor,
    orgId: input.orgId,
    verb: "watchlist.add",
    targetType: "watchlist",
    targetId: entryId,
    reason: input.flagReason,
    detail: { plate: formatted, severity, vehicleType: input.vehicleType },
  });

  publish({ type: "watchlist_change", data: { action: "add", entry: created } });
  return created;
}

export function updateWatchlistEntry(
  id: string,
  patch: {
    plateNumber?: string;
    vehicleType?: string;
    makeModel?: string | null;
    color?: string | null;
    severity?: Severity;
    flagReason?: string;
    notes?: string | null;
    active?: boolean;
    reason?: string;
  },
  actor: Actor,
): WatchlistEntry {
  const existing = getWatchlistEntry(id);
  if (!existing) throw new Error(`no watchlist entry ${id}`);

  const at = nowIso();
  const updatedPlate = patch.plateNumber ? formatPlate(patch.plateNumber) : existing.plate_number;
  const updatedType = patch.vehicleType ?? existing.vehicle_type;
  const updatedMake = patch.makeModel !== undefined ? patch.makeModel : existing.make_model;
  const updatedColor = patch.color !== undefined ? patch.color : existing.color;
  const updatedSeverity = patch.severity ?? existing.severity;
  const updatedReason = patch.flagReason ?? existing.flag_reason;
  const updatedNotes = patch.notes !== undefined ? patch.notes : existing.notes;
  const updatedActive = patch.active !== undefined ? patch.active : existing.active;

  run(
    `UPDATE watchlist_entry
        SET plate_number = $plate,
            vehicle_type = $type,
            make_model = $make,
            color = $color,
            severity = $severity,
            flag_reason = $reason,
            notes = $notes,
            active = $active,
            updated_at = $at
      WHERE id = $id`,
    {
      $id: id,
      $plate: updatedPlate,
      $type: updatedType,
      $make: updatedMake,
      $color: updatedColor,
      $severity: updatedSeverity,
      $reason: updatedReason,
      $notes: updatedNotes,
      $active: int(updatedActive),
      $at: at,
    },
  );

  const updated = getWatchlistEntry(id)!;

  recordAction({
    actor,
    orgId: existing.org_id,
    verb: "watchlist.update",
    targetType: "watchlist",
    targetId: id,
    reason: patch.reason ?? "Watchlist entry updated",
    before: existing,
    after: updated,
  });

  publish({ type: "watchlist_change", data: { action: "update", entry: updated } });
  return updated;
}

export function deleteWatchlistEntry(id: string, reason: string, actor: Actor): void {
  const existing = getWatchlistEntry(id);
  if (!existing) throw new Error(`no watchlist entry ${id}`);

  // Keep historical scans, but detach them from the entry being removed.
  // Without this, a past match's foreign key prevents a supervisor from
  // removing a false-positive vehicle from the watchlist.
  run("UPDATE plate_detection SET matched_watchlist_id = NULL WHERE matched_watchlist_id = $id", { $id: id });
  run("DELETE FROM watchlist_entry WHERE id = $id", { $id: id });

  recordAction({
    actor,
    orgId: existing.org_id,
    verb: "watchlist.delete",
    targetType: "watchlist",
    targetId: id,
    reason,
    before: existing,
  });

  publish({ type: "watchlist_change", data: { action: "delete", entryId: id } });
}

export function getWatchlistStats(orgId: string): WatchlistStats {
  const totalRow = one<{ count: number }>("SELECT COUNT(*) AS count FROM watchlist_entry WHERE org_id = $org", { $org: orgId });
  const activeRow = one<{ count: number }>("SELECT COUNT(*) AS count FROM watchlist_entry WHERE org_id = $org AND active = 1", { $org: orgId });
  const criticalRow = one<{ count: number }>("SELECT COUNT(*) AS count FROM watchlist_entry WHERE org_id = $org AND active = 1 AND severity = 'CRITICAL'", { $org: orgId });
  const warningRow = one<{ count: number }>("SELECT COUNT(*) AS count FROM watchlist_entry WHERE org_id = $org AND active = 1 AND severity = 'WARNING'", { $org: orgId });

  const past24hIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const scansRow = one<{ count: number }>("SELECT COUNT(*) AS count FROM plate_detection WHERE org_id = $org AND simulated = 0 AND verified = 1 AND occurred_at >= $time", {
    $org: orgId,
    $time: past24hIso,
  });
  const matchesRow = one<{ count: number }>("SELECT COUNT(*) AS count FROM plate_detection WHERE org_id = $org AND simulated = 0 AND verified = 1 AND match_status = 'MATCHED' AND occurred_at >= $time", {
    $org: orgId,
    $time: past24hIso,
  });
  const avgConfRow = one<{ avgConf: number }>("SELECT AVG(plate_confidence) AS avgConf FROM plate_detection WHERE org_id = $org AND simulated = 0 AND verified = 1", { $org: orgId });

  const rawAvg = Number(avgConfRow?.avgConf);
  const readRate = Number.isFinite(rawAvg) && rawAvg > 0
    ? Math.round(rawAvg * 1000) / 10
    : 0;

  return {
    totalWatchlist: totalRow?.count ?? 0,
    activeWatchlist: activeRow?.count ?? 0,
    criticalCount: criticalRow?.count ?? 0,
    warningCount: warningRow?.count ?? 0,
    scans24h: scansRow?.count ?? 0,
    matches24h: matchesRow?.count ?? 0,
    readRate,
  };
}

export function recordVehicleTraffic(input: {
  orgId: string;
  cameraId: string;
  sourceKey: string;
  vehicleType?: string;
  occurredAt?: string;
}): { recorded: boolean } {
  const at = input.occurredAt ?? nowIso();
  const before = one<{ id: string }>(
    "SELECT id FROM vehicle_traffic_event WHERE org_id = $org AND source_key = $key",
    { $org: input.orgId, $key: input.sourceKey },
  );
  if (before) return { recorded: false };

  run(
    `INSERT OR IGNORE INTO vehicle_traffic_event
       (id, org_id, camera_id, source_key, vehicle_type, occurred_at, created_at)
     VALUES ($id, $org, $camera, $key, $type, $occurred, $created)`,
    {
      $id: id("traffic"),
      $org: input.orgId,
      $camera: input.cameraId,
      $key: input.sourceKey,
      $type: input.vehicleType ?? "vehicle",
      $occurred: at,
      $created: nowIso(),
    },
  );
  publish({
    type: "vehicle_traffic",
    data: {
      cameraId: input.cameraId,
      sourceKey: input.sourceKey,
      vehicleType: input.vehicleType ?? "vehicle",
      occurredAt: at,
    },
  });
  return { recorded: true };
}

export function getVehicleTraffic(
  orgId: string,
  options: { days?: number; cameraId?: string } = {},
): VehicleTrafficSummary {
  const days = Math.max(1, Math.min(730, Math.floor(options.days ?? 14)));
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (days - 1));

  let sql = `SELECT substr(occurred_at, 1, 10) AS date, COUNT(*) AS total
               FROM vehicle_traffic_event
              WHERE org_id = $org AND occurred_at >= $since`;
  const params: Record<string, any> = { $org: orgId, $since: start.toISOString() };
  if (options.cameraId) {
    sql += " AND camera_id = $camera";
    params.$camera = options.cameraId;
  }
  sql += " GROUP BY substr(occurred_at, 1, 10) ORDER BY date";

  const counts = new Map(
    all<{ date: string; total: number }>(sql, params).map((row) => [row.date, Number(row.total)]),
  );
  const points: VehicleTrafficPoint[] = [];
  for (let offset = 0; offset < days; offset++) {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + offset);
    const key = date.toISOString().slice(0, 10);
    points.push({ date: key, total: counts.get(key) ?? 0 });
  }
  let breakdownWhere = "WHERE org_id = $org AND occurred_at >= $since";
  if (options.cameraId) breakdownWhere += " AND camera_id = $camera";
  const byCamera = Object.fromEntries(all<{ key: string; total: number }>(
    `SELECT camera_id AS key, COUNT(*) AS total
       FROM vehicle_traffic_event ${breakdownWhere}
      GROUP BY camera_id`,
    params,
  ).map((row) => [row.key, Number(row.total)]));
  const byType = Object.fromEntries(all<{ key: string; total: number }>(
    `SELECT UPPER(COALESCE(NULLIF(vehicle_type, ''), 'VEHICLE')) AS key, COUNT(*) AS total
       FROM vehicle_traffic_event ${breakdownWhere}
      GROUP BY UPPER(COALESCE(NULLIF(vehicle_type, ''), 'VEHICLE'))`,
    params,
  ).map((row) => [row.key, Number(row.total)]));
  return { days, total: points.reduce((sum, point) => sum + point.total, 0), points, byCamera, byType };
}

// ------------------------------------------------------------------ Detection & Scanning Engine

export function queryPlateDetections(
  orgId: string,
  options: { matchStatus?: string; cameraId?: string; plateNumber?: string; includeSimulated?: boolean; limit?: number; offset?: number } = {},
): PlateDetection[] {
  purgeExpiredPlateDetections(orgId);

  let sql = `
    SELECT pd.*, c.name AS camera_name, z.name AS zone_name
      FROM plate_detection pd
      LEFT JOIN camera c ON c.id = pd.camera_id
      LEFT JOIN zone z ON z.id = pd.zone_id
     WHERE pd.org_id = $org
  `;
  const params: Record<string, any> = { $org: orgId };

  if (!options.includeSimulated) {
    sql += " AND pd.simulated = 0";
  }

  if (options.matchStatus) {
    sql += " AND pd.match_status = $status";
    params.$status = options.matchStatus;
  }
  if (options.cameraId) {
    sql += " AND pd.camera_id = $cam";
    params.$cam = options.cameraId;
  }
  if (options.plateNumber) {
    // Stored plates are human-formatted (spaces/dashes) while searches can
    // arrive compact. Compare their normalised forms so an incident deep-link
    // can reliably recover the exact ANPR evidence row.
    sql += ` AND REPLACE(REPLACE(REPLACE(UPPER(pd.plate_number), ' ', ''), '-', ''), '.', '') LIKE $plate`;
    params.$plate = `%${normalizePlate(options.plateNumber)}%`;
  }

  sql += " ORDER BY pd.occurred_at DESC";

  const limit = Number(options.limit);
  if (Number.isFinite(limit) && limit > 0) {
    sql += ` LIMIT ${Math.floor(limit)}`;
    const offset = Number(options.offset);
    if (Number.isFinite(offset) && offset > 0) {
      sql += ` OFFSET ${Math.floor(offset)}`;
    }
  }

  const rows = all<any>(sql, params);
  return rows.map(shapePlateDetection);
}

export interface DetectVehicleInput {
  orgId: string;
  cameraId: string;
  zoneId?: string | null;
  plateNumber?: string;
  vehicleType?: string;
  confidence?: number;
  plateConfidence?: number;
  bbox?: [number, number, number, number];
  plateBbox?: [number, number, number, number];
  imageSnapshot?: string | null;
  simulated?: boolean;
  occurredAt?: string;
}

/**
 * Ingest or process a vehicle detection & number plate read.
 * Checks against active watchlist, flags matches, creates an incident/alert for every active hit,
 * and publishes real-time notification to control room stream.
 */
export function processVehicleAndPlateDetection(input: DetectVehicleInput): PlateDetection {
  purgeExpiredPlateDetections(input.orgId);

  const at = input.occurredAt ?? nowIso();
  const detectionId = id("pd");
  const rawPlate = input.plateNumber?.trim() ?? "";
  if (!rawPlate) {
    throw new Error("plateNumber is required; ANPR detections cannot invent a registration");
  }
  const formattedPlate = formatPlate(rawPlate);
  const vehicleType = input.vehicleType ?? "car";

  const confidence = Math.max(0, Math.min(1, input.confidence ?? 0));
  const plateConfidence = Math.max(0, Math.min(1, input.plateConfidence ?? 0));

  // Exact confirmed reads may alert at the OCR floor. Fuzzy glyph recovery is
  // permitted only for a strong read; low-confidence guesses remain CLEAR.
  const matchResult = findWatchlistMatch(input.orgId, formattedPlate, {
    allowFuzzy: plateConfidence >= 0.60,
  });
  const matched = !!matchResult;
  const matchStatus = matched ? "MATCHED" : "CLEAR";
  const severity: Severity = matched ? matchResult.entry.severity : "INFO";

  // The vision service and browser scanner can briefly deliver the same
  // durable read through two transports. Collapse that race before it creates
  // duplicate logs, alerts, and incidents. Camera and simulation truth remain
  // part of the identity, so another checkpoint or a test record is untouched.
  const occurredMs = Date.parse(at);
  const duplicateWindowMs = 12_000;
  if (Number.isFinite(occurredMs)) {
    const duplicate = one<{ id: string; match_status: string }>(
      `SELECT id, match_status FROM plate_detection
        WHERE org_id = $org
          AND camera_id = $camera
          AND simulated = $simulated
          AND REPLACE(REPLACE(REPLACE(UPPER(plate_number), ' ', ''), '-', ''), '.', '') = $plate
          AND occurred_at BETWEEN $from AND $to
        ORDER BY occurred_at DESC
        LIMIT 1`,
      {
        $org: input.orgId,
        $camera: input.cameraId,
        $simulated: int(input.simulated === true),
        $plate: normalizePlate(formattedPlate),
        $from: new Date(occurredMs - duplicateWindowMs).toISOString(),
        $to: new Date(occurredMs + duplicateWindowMs).toISOString(),
      },
    );
    if (duplicate && duplicate.match_status === matchStatus) {
      run(
        `UPDATE plate_detection
            SET confidence = CASE WHEN confidence < $confidence THEN $confidence ELSE confidence END,
                plate_confidence = CASE WHEN plate_confidence < $plateConfidence THEN $plateConfidence ELSE plate_confidence END,
                image_snapshot = CASE WHEN image_snapshot IS NULL OR image_snapshot = '' THEN $snapshot ELSE image_snapshot END
          WHERE id = $id`,
        {
          $id: duplicate.id,
          $confidence: confidence,
          $plateConfidence: plateConfidence,
          $snapshot: input.imageSnapshot ?? null,
        },
      );
      return getPlateDetectionById(duplicate.id)!;
    }
  }

  const defaultVehicleBbox: [number, number, number, number] = [0.20, 0.35, 0.80, 0.85];
  const defaultPlateBbox: [number, number, number, number] = [0.42, 0.70, 0.58, 0.78];

  const bbox = input.bbox ?? defaultVehicleBbox;
  const plateBbox = input.plateBbox ?? defaultPlateBbox;

  run(
    `INSERT INTO plate_detection
       (id, org_id, camera_id, zone_id, plate_number, vehicle_type, confidence, plate_confidence,
        matched_watchlist_id, match_status, severity, bbox, plate_bbox, image_snapshot, simulated, occurred_at, created_at)
     VALUES ($id, $org, $cam, $zone, $plate, $type, $conf, $pconf, $matched, $status, $sev, $bbox, $pbbox, $snap, $sim, $occ, $at)`,
    {
      $id: detectionId,
      $org: input.orgId,
      $cam: input.cameraId,
      $zone: input.zoneId ?? null,
      $plate: formattedPlate,
      $type: vehicleType,
      $conf: confidence,
      $pconf: plateConfidence,
      $matched: matched ? matchResult.entry.id : null,
      $status: matchStatus,
      $sev: severity,
      $bbox: JSON.stringify(bbox),
      $pbbox: JSON.stringify(plateBbox),
      // Missing pixels stay missing. A placeholder filename looks like proof to
      // downstream screens even though no image exists.
      $snap: input.imageSnapshot ?? null,
      $sim: int(input.simulated === true),
      $occ: at,
      $at: at,
    },
  );

  const detection = getPlateDetectionById(detectionId)!;

  // Every active watchlist entry is operationally meaningful. Severity controls
  // prioritisation; it must not decide whether the hit exists or gets an alert.
  if (matched && input.simulated !== true) {
    const camera = one<{ site_id: string; name: string }>("SELECT site_id, name FROM camera WHERE id = $id", { $id: input.cameraId });
    const zone = input.zoneId
      ? one<{ name: string }>("SELECT name FROM zone WHERE id = $id", { $id: input.zoneId })
      : null;
    if (camera) {
      recordEvent({
        orgId: input.orgId,
        siteId: camera.site_id,
        cameraId: input.cameraId,
        zoneId: input.zoneId ?? undefined,
        kind: "sensor_contact",
        sourceType: "camera",
        sourceId: input.cameraId,
        // Always false here: the outer guard (line 688) already requires
        // input.simulated !== true to reach this block.
        simulated: false,
        class: "vehicle",
        severity,
        alertable: true,
        occurredAt: at,
        confidence: plateConfidence,
        rule: `Watchlist hit: ${formattedPlate}`,
        // One case per flagged vehicle. Grouping only by camera/zone could
        // merge two different watchlist vehicles seen within five minutes.
        groupKey: `watchlist:${input.cameraId}:${normalizePlate(formattedPlate)}`,
        title: `Flagged vehicle: ${formattedPlate} (${matchResult.entry.flag_reason})`,
        evidence: {
          type: "watchlist_hit",
          detectionId,
          plateNumber: formattedPlate,
          vehicleType,
          vehicleConfidence: confidence,
          plateConfidence,
          cameraName: camera.name,
          zoneName: zone?.name ?? null,
          matchedWatchlistId: matchResult.entry.id,
          watchlistPlate: matchResult.entry.plate_number,
          flagReason: matchResult.entry.flag_reason,
          makeModel: matchResult.entry.make_model,
          color: matchResult.entry.color,
          notes: matchResult.entry.notes,
          plateBbox,
          vehicleBbox: bbox,
          matchConfidence: matchResult.score,
          exactMatch: matchResult.exact,
          imageAvailable: Boolean(input.imageSnapshot),
        },
      });
    }
  }

  publish({ type: "plate_detection", data: detection });
  return detection;
}

/** Compatibility preset used by the shared demo controls and integration tests. */
export function simulatePresetPlateDetection(presetKey: string, orgId: string): PlateDetection {
  const presets: Record<string, { plateNumber: string; vehicleType: string; cameraId: string; zoneId: string }> = {
    flagged_scorpio: {
      plateNumber: "PB 02 AK 4821",
      vehicleType: "suv",
      cameraId: "cam_fence_north",
      zoneId: "zone_perimeter",
    },
  };
  const preset = presets[presetKey] ?? presets.flagged_scorpio!;
  return processVehicleAndPlateDetection({
    orgId,
    ...preset,
    confidence: 0.95,
    plateConfidence: 0.97,
    imageSnapshot: "preset_scorpio_black",
    simulated: false,
  });
}

export function getPlateDetectionById(id: string): PlateDetection | null {
  const row = one<any>(
    `SELECT pd.*, c.name AS camera_name, z.name AS zone_name
       FROM plate_detection pd
       LEFT JOIN camera c ON c.id = pd.camera_id
       LEFT JOIN zone z ON z.id = pd.zone_id
      WHERE pd.id = $id`,
    { $id: id },
  );
  return row ? shapePlateDetection(row) : null;
}

// ------------------------------------------------------------------ Data Shapeshifters

function shapeWatchlistEntry(row: any): WatchlistEntry {
  return {
    id: row.id,
    org_id: row.org_id,
    plate_number: row.plate_number,
    vehicle_type: row.vehicle_type,
    make_model: row.make_model ?? null,
    color: row.color ?? null,
    severity: row.severity,
    flag_reason: row.flag_reason,
    notes: row.notes ?? null,
    active: bool(row.active),
    added_by: row.added_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function shapePlateDetection(row: any): PlateDetection {
  let bbox: [number, number, number, number] = [0.2, 0.4, 0.8, 0.8];
  let plateBbox: [number, number, number, number] = [0.4, 0.7, 0.6, 0.8];
  try {
    bbox = JSON.parse(row.bbox);
  } catch {}
  try {
    plateBbox = JSON.parse(row.plate_bbox);
  } catch {}

  let matchedEntry: WatchlistEntry | null = null;
  if (row.matched_watchlist_id) {
    matchedEntry = getWatchlistEntry(row.matched_watchlist_id);
  }

  return {
    id: row.id,
    org_id: row.org_id,
    camera_id: row.camera_id,
    camera_name: row.camera_name,
    zone_id: row.zone_id ?? null,
    zone_name: row.zone_name,
    plate_number: row.plate_number,
    vehicle_type: row.vehicle_type,
    confidence: row.confidence,
    plate_confidence: row.plate_confidence,
    matched_watchlist_id: row.matched_watchlist_id ?? null,
    matched_entry: matchedEntry,
    match_status: row.match_status,
    severity: row.severity,
    bbox,
    plate_bbox: plateBbox,
    image_snapshot: row.image_snapshot ?? null,
    simulated: bool(row.simulated),
    plate_verified: row.verified === undefined ? true : bool(row.verified),
    occurred_at: row.occurred_at,
    created_at: row.created_at,
  };
}
