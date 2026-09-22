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
    const paddedDist = dist.padStart(2, "0");
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

  if (a.length !== b.length) {
    // If length differs by 1, check substring / Levenshtein
    if (Math.abs(a.length - b.length) === 1) {
      if (a.includes(b) || b.includes(a)) {
        return { match: true, confidence: 0.88, exact: false };
      }
    }
    return { match: false, confidence: 0, exact: false };
  }

  let mismatches = 0;
  let ocrSubstitutions = 0;

  for (let i = 0; i < a.length; i++) {
    const charA = a[i];
    const charB = b[i];
    if (charA === charB) continue;

    if (ocrSimilar[charA]?.includes(charB) || ocrSimilar[charB]?.includes(charA)) {
      ocrSubstitutions++;
    } else {
      mismatches++;
    }
  }

  if (mismatches === 0 && ocrSubstitutions <= 2) {
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

export function findWatchlistMatch(orgId: string, plateNumber: string): { entry: WatchlistEntry; score: number; exact: boolean } | null {
  const activeEntries = listWatchlist(orgId, { activeOnly: true });
  const cleaned = normalizePlate(plateNumber);

  for (const entry of activeEntries) {
    const check = platesMatch(cleaned, entry.plate_number);
    if (check.match) {
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
  const scansRow = one<{ count: number }>("SELECT COUNT(*) AS count FROM plate_detection WHERE org_id = $org AND occurred_at >= $time", {
    $org: orgId,
    $time: past24hIso,
  });
  const matchesRow = one<{ count: number }>("SELECT COUNT(*) AS count FROM plate_detection WHERE org_id = $org AND match_status = 'MATCHED' AND occurred_at >= $time", {
    $org: orgId,
    $time: past24hIso,
  });
  const avgConfRow = one<{ avgConf: number }>("SELECT AVG(plate_confidence) AS avgConf FROM plate_detection WHERE org_id = $org", { $org: orgId });

  const rawAvg = avgConfRow?.avgConf;
  const readRate = rawAvg ? Math.round(rawAvg * 1000) / 10 : 98.4;

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
  return { days, total: points.reduce((sum, point) => sum + point.total, 0), points };
}

// ------------------------------------------------------------------ Detection & Scanning Engine

export function queryPlateDetections(
  orgId: string,
  options: { matchStatus?: string; cameraId?: string; plateNumber?: string; limit?: number; offset?: number } = {},
): PlateDetection[] {
  let sql = `
    SELECT pd.*, c.name AS camera_name, z.name AS zone_name
      FROM plate_detection pd
      LEFT JOIN camera c ON c.id = pd.camera_id
      LEFT JOIN zone z ON z.id = pd.zone_id
     WHERE pd.org_id = $org
  `;
  const params: Record<string, any> = { $org: orgId };

  if (options.matchStatus) {
    sql += " AND pd.match_status = $status";
    params.$status = options.matchStatus;
  }
  if (options.cameraId) {
    sql += " AND pd.camera_id = $cam";
    params.$cam = options.cameraId;
  }
  if (options.plateNumber) {
    sql += " AND pd.plate_number LIKE $plate";
    params.$plate = `%${normalizePlate(options.plateNumber)}%`;
  }

  sql += " ORDER BY pd.occurred_at DESC";

  const limit = options.limit ?? 50;
  sql += ` LIMIT ${Number(limit)}`;
  if (options.offset) {
    sql += ` OFFSET ${Number(options.offset)}`;
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
 * Checks against active watchlist, flags matches, creates incidents/alerts if critical/warning,
 * and publishes real-time notification to control room stream.
 */
export function processVehicleAndPlateDetection(input: DetectVehicleInput): PlateDetection {
  const at = input.occurredAt ?? nowIso();
  const detectionId = id("pd");
  const rawPlate = input.plateNumber ?? generateRandomPlate();
  const formattedPlate = formatPlate(rawPlate);
  const vehicleType = input.vehicleType ?? "car";

  const confidence = input.confidence ?? 0.94;
  const plateConfidence = input.plateConfidence ?? 0.96;

  // Check against watchlist
  const matchResult = findWatchlistMatch(input.orgId, formattedPlate);
  const matched = !!matchResult;
  const matchStatus = matched ? "MATCHED" : "CLEAR";
  const severity: Severity = matched ? matchResult.entry.severity : "INFO";

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
      $snap: input.imageSnapshot ?? `snapshot_${vehicleType}`,
      $sim: int(input.simulated !== false),
      $occ: at,
      $at: at,
    },
  );

  const detection = getPlateDetectionById(detectionId)!;

  // If matched and severity is high, raise an alertable event
  if (matched && (severity === "CRITICAL" || severity === "WARNING")) {
    const camera = one<{ site_id: string; name: string }>("SELECT site_id, name FROM camera WHERE id = $id", { $id: input.cameraId });
    if (camera) {
      recordEvent({
        orgId: input.orgId,
        siteId: camera.site_id,
        cameraId: input.cameraId,
        zoneId: input.zoneId ?? undefined,
        kind: "sensor_contact",
        sourceType: "camera",
        sourceId: input.cameraId,
        simulated: input.simulated !== false,
        class: "vehicle",
        severity,
        alertable: true,
        occurredAt: at,
        confidence: plateConfidence,
        rule: `Watchlist hit: ${formattedPlate}`,
        groupKey: input.zoneId ? `${input.cameraId}:${input.zoneId}` : `${camera.site_id}:plate:${formattedPlate}`,
        title: `Flagged vehicle: ${formattedPlate} (${matchResult.entry.flag_reason})`,
        evidence: {
          plateNumber: formattedPlate,
          vehicleType,
          matchedWatchlistId: matchResult.entry.id,
          flagReason: matchResult.entry.flag_reason,
          makeModel: matchResult.entry.make_model,
          color: matchResult.entry.color,
          notes: matchResult.entry.notes,
          plateBbox,
          vehicleBbox: bbox,
          ocrScore: matchResult.score,
        },
      });
    }
  }

  publish({ type: "plate_detection", data: detection });
  return detection;
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

// ------------------------------------------------------------------ Presets & Simulator

export const PRESET_DETECTIONS: Record<string, {
  plateNumber: string;
  vehicleType: string;
  cameraId: string;
  zoneId: string;
  imageSnapshot: string;
  confidence: number;
  plateConfidence: number;
  bbox: [number, number, number, number];
  plateBbox: [number, number, number, number];
  notes?: string;
}> = {
  flagged_scorpio: {
    plateNumber: "PB 02 AK 4821",
    vehicleType: "suv",
    cameraId: "cam_fence_north",
    zoneId: "zone_fence_line",
    imageSnapshot: "preset_scorpio_black",
    confidence: 0.95,
    plateConfidence: 0.97,
    bbox: [0.22, 0.44, 0.78, 0.88],
    plateBbox: [0.44, 0.73, 0.58, 0.80],
  },
  flagged_tractor: {
    plateNumber: "PB 02 T 9182",
    vehicleType: "tractor",
    cameraId: "cam_farm_gate",
    zoneId: "zone_farm_gate",
    imageSnapshot: "preset_tractor_blue",
    confidence: 0.91,
    plateConfidence: 0.93,
    bbox: [0.28, 0.38, 0.72, 0.84],
    plateBbox: [0.46, 0.68, 0.56, 0.74],
  },
  stolen_fortuner: {
    plateNumber: "DL 1C AA 1111",
    vehicleType: "suv",
    cameraId: "cam_fence_north",
    zoneId: "zone_fence_line",
    imageSnapshot: "preset_fortuner_white",
    confidence: 0.96,
    plateConfidence: 0.98,
    bbox: [0.20, 0.40, 0.80, 0.86],
    plateBbox: [0.43, 0.71, 0.57, 0.78],
  },
  commercial_truck: {
    plateNumber: "HR 26 DQ 5512",
    vehicleType: "truck",
    cameraId: "cam_patrol_road",
    zoneId: "zone_patrol_road",
    imageSnapshot: "preset_truck_silver",
    confidence: 0.92,
    plateConfidence: 0.94,
    bbox: [0.15, 0.32, 0.85, 0.90],
    plateBbox: [0.41, 0.75, 0.59, 0.83],
  },
  farm_sonalika: {
    plateNumber: "PB 02 AB 1042",
    vehicleType: "tractor",
    cameraId: "cam_farm_gate",
    zoneId: "zone_farm_gate",
    imageSnapshot: "preset_sonalika_red",
    confidence: 0.89,
    plateConfidence: 0.91,
    bbox: [0.30, 0.42, 0.70, 0.86],
    plateBbox: [0.47, 0.70, 0.55, 0.76],
  },
  patrol_bolero: {
    plateNumber: "PB 02 E 3391",
    vehicleType: "car",
    cameraId: "cam_patrol_road",
    zoneId: "zone_patrol_road",
    imageSnapshot: "preset_bolero_white",
    confidence: 0.97,
    plateConfidence: 0.96,
    bbox: [0.18, 0.48, 0.68, 0.91],
    plateBbox: [0.38, 0.78, 0.50, 0.84],
  },
  highway_creta: {
    plateNumber: "MH 12 BB 8892",
    vehicleType: "car",
    cameraId: "cam_fence_north",
    zoneId: "zone_fence_line",
    imageSnapshot: "preset_creta_red",
    confidence: 0.96,
    plateConfidence: 0.97,
    bbox: [0.19, 0.42, 0.75, 0.87],
    plateBbox: [0.42, 0.72, 0.56, 0.79],
  },
  surveillance_brezza: {
    plateNumber: "PB 08 BX 7744",
    vehicleType: "car",
    cameraId: "cam_patrol_road",
    zoneId: "zone_patrol_road",
    imageSnapshot: "preset_brezza_blue",
    confidence: 0.95,
    plateConfidence: 0.96,
    bbox: [0.21, 0.45, 0.74, 0.89],
    plateBbox: [0.43, 0.74, 0.55, 0.81],
  },
  night_eicher: {
    plateNumber: "RJ 14 XY 3319",
    vehicleType: "truck",
    cameraId: "cam_fence_north",
    zoneId: "zone_fence_line",
    imageSnapshot: "preset_eicher_white",
    confidence: 0.93,
    plateConfidence: 0.95,
    bbox: [0.14, 0.30, 0.86, 0.92],
    plateBbox: [0.40, 0.76, 0.60, 0.84],
  },
  gate_nexon: {
    plateNumber: "UP 16 CZ 9021",
    vehicleType: "car",
    cameraId: "cam_farm_gate",
    zoneId: "zone_farm_gate",
    imageSnapshot: "preset_nexon_silver",
    confidence: 0.94,
    plateConfidence: 0.95,
    bbox: [0.20, 0.44, 0.76, 0.88],
    plateBbox: [0.42, 0.73, 0.56, 0.80],
  },
};

export function simulatePresetPlateDetection(presetKey: string, orgId: string): PlateDetection {
  const preset = PRESET_DETECTIONS[presetKey] ?? PRESET_DETECTIONS.flagged_scorpio;
  return processVehicleAndPlateDetection({
    orgId,
    cameraId: preset.cameraId,
    zoneId: preset.zoneId,
    plateNumber: preset.plateNumber,
    vehicleType: preset.vehicleType,
    confidence: preset.confidence,
    plateConfidence: preset.plateConfidence,
    bbox: preset.bbox,
    plateBbox: preset.plateBbox,
    imageSnapshot: preset.imageSnapshot,
    simulated: true,
  });
}

export interface FrameAnalysisResult {
  detections: PlateDetection[];
  totalInView: number;
}

export function analyzeFrame(orgId: string, options: {
  cameraId?: string;
  zoneId?: string | null;
  timeOffset?: number;
  simulated?: boolean;
} = {}): FrameAnalysisResult {
  const time = options.timeOffset ?? (Date.now() / 1000);
  const cameraId = options.cameraId ?? "cam_fence_north";

  const SCENARIOS = [
    [
      {
        plate: "PB 02 AK 4821",
        type: "suv",
        conf: 0.96,
        pconf: 0.98,
        bbox: [0.18, 0.38, 0.62, 0.86] as [number, number, number, number],
        pbbox: [0.36, 0.72, 0.48, 0.80] as [number, number, number, number],
      },
    ],
    [
      {
        plate: "PB 02 AK 4821",
        type: "suv",
        conf: 0.97,
        pconf: 0.98,
        bbox: [0.12, 0.34, 0.54, 0.82] as [number, number, number, number],
        pbbox: [0.28, 0.68, 0.40, 0.76] as [number, number, number, number],
      },
      {
        plate: "PB 02 E 3391",
        type: "car",
        conf: 0.93,
        pconf: 0.95,
        bbox: [0.58, 0.44, 0.88, 0.88] as [number, number, number, number],
        pbbox: [0.70, 0.74, 0.80, 0.82] as [number, number, number, number],
      },
    ],
    [
      {
        plate: "PB 02 T 9182",
        type: "tractor",
        conf: 0.92,
        pconf: 0.94,
        bbox: [0.28, 0.36, 0.74, 0.84] as [number, number, number, number],
        pbbox: [0.46, 0.68, 0.56, 0.75] as [number, number, number, number],
      },
    ],
    [
      {
        plate: "DL 1C AA 1111",
        type: "suv",
        conf: 0.96,
        pconf: 0.97,
        bbox: [0.20, 0.38, 0.68, 0.84] as [number, number, number, number],
        pbbox: [0.40, 0.70, 0.52, 0.78] as [number, number, number, number],
      },
      {
        plate: "HR 26 DQ 5512",
        type: "truck",
        conf: 0.94,
        pconf: 0.95,
        bbox: [0.65, 0.30, 0.94, 0.88] as [number, number, number, number],
        pbbox: [0.76, 0.72, 0.86, 0.80] as [number, number, number, number],
      },
    ],
    [
      {
        plate: "PB 02 AB 1042",
        type: "tractor",
        conf: 0.90,
        pconf: 0.92,
        bbox: [0.30, 0.40, 0.70, 0.85] as [number, number, number, number],
        pbbox: [0.47, 0.70, 0.55, 0.76] as [number, number, number, number],
      },
    ],
    [
      {
        plate: "PB 08 BX 7744",
        type: "car",
        conf: 0.95,
        pconf: 0.96,
        bbox: [0.22, 0.42, 0.72, 0.88] as [number, number, number, number],
        pbbox: [0.42, 0.73, 0.54, 0.81] as [number, number, number, number],
      },
    ],
    [
      {
        plate: "UP 16 CZ 9021",
        type: "car",
        conf: 0.94,
        pconf: 0.95,
        bbox: [0.18, 0.40, 0.70, 0.86] as [number, number, number, number],
        pbbox: [0.38, 0.70, 0.52, 0.78] as [number, number, number, number],
      },
      {
        plate: "RJ 14 XY 3319",
        type: "truck",
        conf: 0.92,
        pconf: 0.94,
        bbox: [0.62, 0.32, 0.92, 0.88] as [number, number, number, number],
        pbbox: [0.74, 0.74, 0.85, 0.82] as [number, number, number, number],
      },
    ],
    [
      {
        plate: "MH 12 BB 8892",
        type: "car",
        conf: 0.96,
        pconf: 0.97,
        bbox: [0.22, 0.42, 0.74, 0.88] as [number, number, number, number],
        pbbox: [0.42, 0.72, 0.56, 0.80] as [number, number, number, number],
      },
    ],
    [
      {
        plate: "KA 01 MG 4410",
        type: "truck",
        conf: 0.91,
        pconf: 0.93,
        bbox: [0.16, 0.30, 0.84, 0.90] as [number, number, number, number],
        pbbox: [0.40, 0.74, 0.58, 0.82] as [number, number, number, number],
      },
    ],
  ];

  const idx = Math.floor(Math.abs(time)) % SCENARIOS.length;
  const currentScenario = SCENARIOS[idx];

  const detections: PlateDetection[] = currentScenario.map((veh) => {
    return processVehicleAndPlateDetection({
      orgId,
      cameraId,
      zoneId: options.zoneId ?? null,
      plateNumber: veh.plate,
      vehicleType: veh.type,
      confidence: veh.conf,
      plateConfidence: veh.pconf,
      bbox: veh.bbox,
      plateBbox: veh.pbbox,
      simulated: options.simulated !== false,
    });
  });

  return {
    detections,
    totalInView: detections.length,
  };
}

export function generateRandomPlate(): string {
  const states = ["PB", "HR", "DL", "UP", "RJ", "MH", "KA", "GJ", "CH", "UK", "TS", "WB"];
  const state = states[Math.floor(Math.random() * states.length)];
  const district = String(Math.floor(Math.random() * 90) + 1).padStart(2, "0");
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const char1 = letters[Math.floor(Math.random() * letters.length)];
  const char2 = letters[Math.floor(Math.random() * letters.length)];
  const number = String(Math.floor(Math.random() * 9000) + 1000);
  return `${state} ${district} ${char1}${char2} ${number}`;
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
    occurred_at: row.occurred_at,
    created_at: row.created_at,
  };
}
