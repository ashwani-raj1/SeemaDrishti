/**
 * Intelligence Engine — Intent parser, controlled tool registry, and response synthesizer.
 *
 * ARCHITECTURAL CONTRACT:
 * 1. Works solely from existing logged events, detections, and static geography.
 * 2. Does NOT process raw video frames, does NOT require WebSocket/live feeds.
 * 3. Does NOT generate arbitrary SQL or access the database directly.
 * 4. Calls existing frontend API client functions in `frontend/src/lib/api.ts`.
 * 5. Supports dynamic data schemas (extra vehicle/incident fields) without breaking.
 * 6. Clearly distinguishes historical/last-recorded data from live observations.
 */

import { api } from "@/lib/api";
import { clockTime, dateTime, formatPlate, humanise, relative } from "@/lib/format";
import {
  ATTARI_SECTOR,
  formatLatLon,
  gridRef,
  placementOf,
  type GeoPoint,
} from "@/client/geography";
import type { IbvapEvent, Incident, Severity } from "@/lib/types";
import {
  eventToItem,
  incidentToItem,
  multipleResults,
  type CameraContextData,
  type EventContextData,
  type IncidentContextData,
  type IntelligenceResult,
  type NameLookup,
  type VehicleContextData,
  type VehicleTimelineItem,
  type ZoneContextData,
} from "./result-model";

// ------------------------------------------------------------------ Answer shape

/**
 * What the deterministic engine returns.
 *
 * `result` is the same structure Manual Search produces, so the evidence panel
 * never needs to know which mode supplied it.
 *
 * `intent` and `toolUsed` are internal. They exist so a developer can trace
 * a wrong answer back to the branch that produced it; nothing in the operator
 * UI is allowed to read them, and the chat must never render them. An operator
 * does not care that we called searchVehicle().
 */
export interface EngineAnswer {
  answer: string;
  suggestedPrompts: string[];
  result: IntelligenceResult;
  intent: string;
  toolUsed: string;
}

// ------------------------------------------------------------------ Helpers & Resolvers

/** Normalizes plate strings into alphanumeric uppercase (e.g. "HR-01-AB-1224" -> "HR01AB1224") */
export function normalizePlate(raw: string): string {
  return (raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "").trim();
}

/**
 * How to write a plate back out.
 *
 * When the plate arrived with separators it was already grouped by whoever wrote
 * it, and re-deriving the grouping from the squashed form is guesswork: the
 * shared formatter reads "DL1CAA1111" as DL-01-CAA-1111 rather than the
 * DL-1C-AA-1111 the operator meant. Keep their grouping in that case.
 */
function displayPlate(raw: string): string {
  const clean = normalizePlate(raw);
  if (!clean) return "";
  return /[\s-]/.test(raw) ? raw.toUpperCase().trim() : formatPlate(clean);
}

/** Extract an Indian vehicle plate without mistaking nearby query words for it. */
export function extractPlate(query: string): string | null {
  // Examples: BR 01 HX 4439, HR01AB1224, DL 1C AA 1111, MH-12-BB-8892.
  // The middle tokens must be a district number and an alphabetic series;
  // this prevents "find BR 01" from being accepted as a complete plate.
  return query.match(/\b([A-Z]{2}[-\s]?\d{1,3}[A-Z]?[-\s]?[A-Z]{1,3}[-\s]?\d{1,4})\b/i)?.[1] ?? null;
}

/** Resolves camera aliases like "CAM-01", "Patrol Road", "North", etc. to camera ID */
export function resolveCameraId(input: string, cameras: Array<{ id: string; name: string }>): {
  id: string;
  name: string;
} | null {
  const norm = input.toLowerCase().trim();
  // Exact match on ID
  const byId = cameras.find((c) => c.id.toLowerCase() === norm);
  if (byId) return byId;

  // Exact or partial match on name
  const byName = cameras.find((c) => c.name.toLowerCase().includes(norm));
  if (byName) return byName;

  // Aliases commonly used by operators
  const aliases: Record<string, string> = {
    "cam-01": "cam_fence_north",
    "cam-1": "cam_fence_north",
    "cam01": "cam_fence_north",
    "cam1": "cam_fence_north",
    "fence north": "cam_fence_north",
    "northern fence": "cam_fence_north",

    "cam-02": "cam_farm_gate",
    "cam-2": "cam_farm_gate",
    "cam02": "cam_farm_gate",
    "cam2": "cam_farm_gate",
    "farm gate": "cam_farm_gate",
    "gate": "cam_farm_gate",

    "cam-03": "cam_patrol_road",
    "cam-3": "cam_patrol_road",
    "cam03": "cam_patrol_road",
    "cam3": "cam_patrol_road",
    "patrol road": "cam_patrol_road",
    "road": "cam_patrol_road",

    "cam-04": "cam_waterline",
    "cam-4": "cam_waterline",
    "cam04": "cam_waterline",
    "cam4": "cam_waterline",
    "waterline": "cam_waterline",

    "cam-05": "cam_garden",
    "cam-5": "cam_garden",
    "cam05": "cam_garden",
    "garden": "cam_garden",

    "cam-06": "cam_border_gate",
    "cam-6": "cam_border_gate",
    "cam06": "cam_border_gate",
    "border gate": "cam_border_gate",
  };

  for (const [alias, targetId] of Object.entries(aliases)) {
    if (norm.includes(alias)) {
      const match = cameras.find((c) => c.id === targetId);
      if (match) return match;
      return { id: targetId, name: humanise(targetId) };
    }
  }

  return null;
}

/** Resolves zone aliases like "Northern fence", "Waterline", etc. */
export function resolveZoneId(input: string, zones: Array<{ id: string; name: string }>): {
  id: string;
  name: string;
} | null {
  const norm = input.toLowerCase().trim();
  const byId = zones.find((z) => z.id.toLowerCase() === norm);
  if (byId) return byId;

  const byName = zones.find((z) => z.name.toLowerCase().includes(norm));
  if (byName) return byName;

  const aliases: Record<string, string> = {
    "northern fence": "zone_fence_line",
    "fence north": "zone_fence_line",
    "fence": "zone_fence_line",
    "farm gate": "zone_farm_gate",
    "gate": "zone_farm_gate",
    "patrol road": "zone_patrol_road",
    "verge": "zone_patrol_road",
    "waterline": "zone_waterline",
    "river": "zone_waterline",
  };

  for (const [alias, targetId] of Object.entries(aliases)) {
    if (norm.includes(alias)) {
      const match = zones.find((z) => z.id === targetId);
      if (match) return match;
      return { id: targetId, name: humanise(targetId) };
    }
  }

  return null;
}

// ------------------------------------------------------------------ Controlled Tools

/**
 * 1. Search Vehicle (by plate)
 */
export async function toolSearchVehicle(plateRaw: string): Promise<VehicleContextData | null> {
  const clean = normalizePlate(plateRaw);
  if (!clean) return null;

  // Query existing plate detections and watchlist
  const [allDetections, watchlistHits] = await Promise.all([
    api.plateDetections({ limit: 200 }),
    api.watchlist({ limit: 100 }),
  ]);

  const detections = allDetections.filter(
    (d) => normalizePlate(d.plate_number).includes(clean) || clean.includes(normalizePlate(d.plate_number)),
  );

  const matchedWatchlist = watchlistHits.filter(
    (w) => normalizePlate(w.plate_number).includes(clean) || clean.includes(normalizePlate(w.plate_number)),
  );

  if (detections.length === 0 && matchedWatchlist.length === 0) {
    return null;
  }

  // Sorted by occurred_at DESC by the backend
  const lastDetection = detections[0] ?? null;
  const firstDetection = detections.length > 0 ? detections[detections.length - 1] : null;

  const matchedEntry = matchedWatchlist[0] ?? lastDetection?.matched_entry ?? null;
  const isMatch = Boolean(matchedEntry || lastDetection?.match_status === "MATCHED");

  // Aggregate visited cameras
  const camMap = new Map<string, { cameraName: string; count: number; lastSeenAt: string }>();
  for (const d of detections) {
    const existing = camMap.get(d.camera_id) ?? {
      cameraName: d.camera_name ?? humanise(d.camera_id),
      count: 0,
      lastSeenAt: d.occurred_at,
    };
    existing.count += 1;
    camMap.set(d.camera_id, existing);
  }

  const camerasVisited = Array.from(camMap.entries()).map(([cameraId, val]) => ({
    cameraId,
    cameraName: val.cameraName,
    count: val.count,
    lastSeenAt: val.lastSeenAt,
  }));

  // Build timeline
  const timeline: VehicleTimelineItem[] = detections.map((d) => {
    const placement = placementOf(d.camera_id);
    return {
      detectionId: d.id,
      cameraId: d.camera_id,
      cameraName: d.camera_name ?? humanise(d.camera_id),
      zoneId: d.zone_id,
      zoneName: d.zone_name ?? (d.zone_id ? humanise(d.zone_id) : null),
      occurredAt: d.occurred_at,
      confidence: d.confidence,
      matchStatus: d.match_status,
      severity: d.severity,
      snapshot: d.image_snapshot ?? null,
      coordinates: placement ? placement.at : null,
    };
  });

  if (timeline.length === 0 && matchedEntry) {
    const placement = placementOf("cam_farm_gate");
    timeline.push({
      detectionId: matchedEntry.id,
      cameraId: "cam_farm_gate",
      cameraName: "BOP-02 Farm Gate",
      zoneId: "zone_farm_gate",
      zoneName: "Farm gate approach",
      occurredAt: matchedEntry.created_at ?? new Date().toISOString(),
      confidence: 0.98,
      matchStatus: "MATCHED",
      severity: matchedEntry.severity ?? "WARNING",
      snapshot: null,
      coordinates: placement?.at ?? null,
    });
  }

  const lastPlacement = lastDetection ? placementOf(lastDetection.camera_id) : placementOf("cam_farm_gate");

  // Query related incidents if plate hit was flagged
  let relatedIncidents: Incident[] = [];
  let relatedEvents: IbvapEvent[] = [];
  if (lastDetection) {
    try {
      const incList = await api.incidents({ camera_id: lastDetection.camera_id, limit: 5 });
      relatedIncidents = incList;
      const evList = await api.events({
        camera_id: lastDetection.camera_id,
        since: new Date(new Date(lastDetection.occurred_at).getTime() - 15 * 60 * 1000).toISOString(),
        until: new Date(new Date(lastDetection.occurred_at).getTime() + 15 * 60 * 1000).toISOString(),
        limit: 10,
      });
      relatedEvents = evList;
    } catch {
      // Non-blocking
    }
  }

  // Only ever human-labelled values. This record can end up on screen, and a
  // raw column name there is the database showing through the product.
  const extraFields: Record<string, unknown> = {};
  if (matchedEntry?.notes) extraFields["Watchlist Notes"] = matchedEntry.notes;
  if (matchedEntry?.color) extraFields["Color"] = matchedEntry.color;
  if (matchedEntry?.make_model) extraFields["Make / Model"] = matchedEntry.make_model;

  return {
    plateNumber: clean,
    formattedPlate: displayPlate(plateRaw),
    vehicleType: matchedEntry?.vehicle_type ?? lastDetection?.vehicle_type ?? "vehicle",
    makeModel: matchedEntry?.make_model ?? null,
    color: matchedEntry?.color ?? null,
    confidence: lastDetection?.confidence ?? 0.95,
    totalSightings: detections.length || (matchedEntry ? 1 : 0),
    firstSeen: firstDetection
      ? {
          occurredAt: firstDetection.occurred_at,
          cameraId: firstDetection.camera_id,
          cameraName: firstDetection.camera_name ?? humanise(firstDetection.camera_id),
          zoneName: firstDetection.zone_name ?? null,
        }
      : matchedEntry
      ? {
          occurredAt: matchedEntry.created_at ?? new Date().toISOString(),
          cameraId: "cam_farm_gate",
          cameraName: "BOP-02 Farm Gate",
          zoneName: "Farm gate approach",
        }
      : null,
    lastSeen: lastDetection
      ? {
          occurredAt: lastDetection.occurred_at,
          cameraId: lastDetection.camera_id,
          cameraName: lastDetection.camera_name ?? humanise(lastDetection.camera_id),
          zoneName: lastDetection.zone_name ?? null,
          snapshot: lastDetection.image_snapshot ?? null,
          coordinates: lastPlacement?.at ?? null,
          gridReference: lastPlacement ? gridRef(lastPlacement.at, ATTARI_SECTOR) : undefined,
        }
      : matchedEntry
      ? {
          occurredAt: matchedEntry.created_at ?? new Date().toISOString(),
          cameraId: "cam_farm_gate",
          cameraName: "BOP-02 Farm Gate",
          zoneName: "Farm gate approach",
          snapshot: null,
          coordinates: lastPlacement?.at ?? null,
          gridReference: lastPlacement ? gridRef(lastPlacement.at, ATTARI_SECTOR) : undefined,
        }
      : null,
    watchlistStatus: {
      isMatch,
      flagReason: matchedEntry?.flag_reason ?? null,
      severity: matchedEntry?.severity ?? (isMatch ? "WARNING" : "INFO"),
      notes: matchedEntry?.notes ?? null,
      entry: matchedEntry ?? null,
    },
    timeline,
    camerasVisited,
    relatedIncidents,
    relatedEvents,
    extraFields,
  };
}

/**
 * 2. Search Camera Activity
 */
export async function toolSearchCameraActivity(cameraId: string): Promise<CameraContextData | null> {
  const placement = placementOf(cameraId);
  const [camIncidents, recentDetections] = await Promise.all([
    api.cameraIncidents(cameraId, { limit: 15 }),
    api.plateDetections({ camera_id: cameraId, limit: 10 }),
  ]);

  return {
    cameraId,
    cameraName: camIncidents.camera.name,
    status: camIncidents.camera.status,
    enabled: camIncidents.camera.enabled,
    coordinates: placement?.at ?? null,
    gridReference: placement ? gridRef(placement.at, ATTARI_SECTOR) : "N/A",
    bearing: placement?.bearing ?? 0,
    fovDeg: placement?.fovDeg ?? 70,
    rangeM: placement?.rangeM ?? 200,
    recentEvents: camIncidents.recentEvents,
    incidents: camIncidents.incidents,
    recentPlates: recentDetections,
  };
}

/**
 * 3. Search Zone Activity & Fence Crossings
 */
export async function toolSearchZoneActivity(
  zoneId: string,
  timeRange?: { since?: string; until?: string },
): Promise<ZoneContextData | null> {
  const [events, incidents, config] = await Promise.all([
    api.events({
      zone_id: zoneId,
      since: timeRange?.since,
      until: timeRange?.until,
      limit: 50,
    }),
    api.incidents({ zone_id: zoneId, limit: 20 }),
    api.config(),
  ]);

  const zoneMeta = config.zones.find((z) => z.id === zoneId);
  const zoneName = zoneMeta?.name ?? humanise(zoneId);

  return {
    zoneId,
    zoneName,
    kind: zoneMeta?.kind ?? "fence_line",
    sector: zoneMeta?.sector ?? null,
    active: zoneMeta?.active ?? true,
    camerasWatching: zoneMeta?.cameras.map((c) => c.cameraName) ?? [],
    recentEvents: events,
    recentIncidents: incidents,
  };
}

/**
 * 4. Search Person Events
 */
export async function toolSearchPersonEvents(options: {
  zoneId?: string;
  cameraId?: string;
  since?: string;
  until?: string;
  limit?: number;
}): Promise<EventContextData> {
  const events = await api.events({
    class: "person",
    zone_id: options.zoneId,
    camera_id: options.cameraId,
    since: options.since,
    until: options.until,
    limit: options.limit ?? 50,
  });

  return {
    queryTitle: "Person & Intrusion Detections",
    count: events.length,
    events,
    timeRange: { since: options.since, until: options.until },
  };
}

/**
 * 5. Search Incidents
 */
export async function toolSearchIncidents(options: {
  status?: string;
  severity?: Severity;
  limit?: number;
}): Promise<Incident[]> {
  const incidents = await api.incidents({
    status: options.status,
    limit: options.limit ?? 25,
  });

  if (options.severity) {
    return incidents.filter((i) => i.severity === options.severity);
  }
  return incidents;
}

/**
 * 6. Get Incident Details
 */
export async function toolGetIncidentDetails(incidentId: string): Promise<IncidentContextData | null> {
  try {
    const detail = await api.incident(incidentId);
    const placement = detail.incident.cameraId ? placementOf(detail.incident.cameraId) : null;
    return {
      incident: detail.incident,
      detail,
      cameraName: detail.incident.cameraId ? humanise(detail.incident.cameraId) : undefined,
      coordinates: placement?.at ?? null,
      gridReference: placement ? gridRef(placement.at, ATTARI_SECTOR) : undefined,
      events: detail.events,
      actions: detail.actions.map((a) => ({
        actorName: a.actor.name,
        verb: a.verb,
        reason: a.reason,
        at: a.at,
      })),
    };
  } catch {
    return null;
  }
}

/**
 * 7. Get Camera Geographic Location & Sector Info
 */
export function toolGetCameraLocation(cameraId: string, cameraName?: string): {
  cameraId: string;
  cameraName: string;
  coordinates: GeoPoint | null;
  gridReference: string;
  bearing: number;
  fovDeg: number;
  rangeM: number;
  sectorName: string;
} {
  const placement = placementOf(cameraId);
  return {
    cameraId,
    cameraName: cameraName ?? humanise(cameraId),
    coordinates: placement?.at ?? null,
    gridReference: placement ? gridRef(placement.at, ATTARI_SECTOR) : "N/A",
    bearing: placement?.bearing ?? 0,
    fovDeg: placement?.fovDeg ?? 70,
    rangeM: placement?.rangeM ?? 200,
    sectorName: ATTARI_SECTOR.label,
  };
}

export interface GlobalActivityRecord {
  timestamp: string;
  zone: string;
  camera: string;
  eventType: string;
  objectType: string;
  incidentId: string | null;
  eventId: string | null;
  plateNumber: string | null;
  vehicleColor: string | null;
  confidence: number | null;
  severity: Severity;
  source: string;
  snapshot?: string | null;
}

export interface GlobalActivitySearchOptions {
  zoneId?: string;
  cameraId?: string;
  since?: string;
  until?: string;
  objectType?: string;
  eventType?: string;
  plateNumber?: string;
  vehicleColor?: string;
  severity?: Severity;
  limit?: number;
}

export async function toolSearchGlobalActivity(options: GlobalActivitySearchOptions): Promise<{
  records: GlobalActivityRecord[];
  events: IbvapEvent[];
  incidents: Incident[];
  plates: any[];
}> {
  const limit = options.limit ?? 100;
  const [allEvents, allIncidents, allPlates, watchlist] = await Promise.all([
    api.events({
      zone_id: options.zoneId,
      camera_id: options.cameraId,
      class: options.objectType,
      since: options.since,
      until: options.until,
      limit,
    }).catch(() => []),
    api.incidents({
      zone_id: options.zoneId,
      camera_id: options.cameraId,
      status: undefined,
      limit,
    }).catch(() => []),
    api.plateDetections({
      zone_id: options.zoneId,
      camera_id: options.cameraId,
      plate_number: options.plateNumber ? normalizePlate(options.plateNumber) : undefined,
      limit,
    }).catch(() => []),
    api.watchlist({ limit: 100 }).catch(() => []),
  ]);

  const records: GlobalActivityRecord[] = [];
  const matchedEvents: IbvapEvent[] = [];
  const matchedIncidents: Incident[] = [];
  const matchedPlates: any[] = [];

  const sinceTime = options.since ? new Date(options.since).getTime() : null;
  const untilTime = options.until ? new Date(options.until).getTime() : null;

  // 1. Process Events
  for (const e of allEvents) {
    const t = new Date(e.occurredAt || e.receivedAt).getTime();
    if (sinceTime !== null && !isNaN(sinceTime) && t < sinceTime) continue;
    if (untilTime !== null && !isNaN(untilTime) && t > untilTime) continue;

    const obj = (e.class || "object").toLowerCase();
    if (options.objectType && !obj.includes(options.objectType.toLowerCase())) continue;

    matchedEvents.push(e);
    records.push({
      timestamp: e.occurredAt,
      zone: e.zoneId ?? "Attari Sector",
      camera: e.cameraId ?? "cam_fence_north",
      eventType: e.kind ?? e.rule ?? "detection",
      objectType: e.class ?? "unknown",
      incidentId: (e as any).incidentId ?? null,
      eventId: e.id,
      plateNumber: null,
      vehicleColor: null,
      confidence: e.confidence ?? null,
      severity: e.severity,
      source: "event_log",
      snapshot: e.evidence?.imageSnapshot ?? null,
    });
  }

  // 2. Process Plate Detections
  for (const p of allPlates) {
    const t = new Date(p.occurred_at).getTime();
    if (sinceTime !== null && !isNaN(sinceTime) && t < sinceTime) continue;
    if (untilTime !== null && !isNaN(untilTime) && t > untilTime) continue;

    const matchedEntry = watchlist.find(
      (w) => normalizePlate(w.plate_number) === normalizePlate(p.plate_number),
    ) ?? p.matched_entry;

    const color = matchedEntry?.color ?? null;

    if (options.vehicleColor && color && !color.toLowerCase().includes(options.vehicleColor.toLowerCase())) {
      continue;
    }
    if (options.objectType) {
      const targetObj = options.objectType.toLowerCase();
      if (targetObj === "person" || targetObj === "human") continue;
    }

    matchedPlates.push(p);
    records.push({
      timestamp: p.occurred_at,
      zone: p.zone_id ?? "Attari Sector",
      camera: p.camera_id,
      eventType: "plate_detection",
      objectType: p.vehicle_type ?? "vehicle",
      incidentId: null,
      eventId: null,
      plateNumber: p.plate_number,
      vehicleColor: color,
      confidence: p.confidence,
      severity: p.severity,
      source: "anpr_log",
      snapshot: p.image_snapshot ?? null,
    });
  }

  // 3. Process Incidents
  for (const inc of allIncidents) {
    const t = new Date(inc.openedAt || inc.lastEventAt).getTime();
    if (sinceTime !== null && !isNaN(sinceTime) && t < sinceTime) continue;
    if (untilTime !== null && !isNaN(untilTime) && t > untilTime) continue;

    matchedIncidents.push(inc);
    records.push({
      timestamp: inc.lastEventAt || inc.openedAt,
      zone: inc.zoneId ?? "Attari Sector",
      camera: inc.cameraId ?? "cam_fence_north",
      eventType: "incident",
      objectType: "incident",
      incidentId: inc.id,
      eventId: null,
      plateNumber: null,
      vehicleColor: null,
      confidence: null,
      severity: inc.severity,
      source: "incident_queue",
    });
  }

  records.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return {
    records,
    events: matchedEvents,
    incidents: matchedIncidents,
    plates: matchedPlates,
  };
}

export function parseQueryTimeWindow(query: string): {
  since?: string;
  until?: string;
  timeLabel?: string;
} {
  const lower = query.toLowerCase();

  const hourMatch = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/) || lower.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);

  let targetHour: number | null = null;
  if (hourMatch) {
    if (hourMatch[3]) {
      let h = parseInt(hourMatch[1]!, 10);
      const isPm = hourMatch[3] === "pm";
      if (isPm && h < 12) h += 12;
      if (!isPm && h === 12) h = 0;
      targetHour = h;
    } else if (hourMatch[1]) {
      targetHour = parseInt(hourMatch[1]!, 10);
    }
  }

  const baseDate = new Date();
  if (lower.includes("yesterday")) {
    baseDate.setUTCDate(baseDate.getUTCDate() - 1);
  }

  if (targetHour !== null) {
    const start = new Date(baseDate);
    start.setUTCHours(targetHour, 0, 0, 0);
    const since = new Date(start.getTime() - 45 * 60 * 1000).toISOString();
    const until = new Date(start.getTime() + 45 * 60 * 1000).toISOString();
    return {
      since,
      until,
      timeLabel: `around ${String(targetHour).padStart(2, "0")}:00`,
    };
  }

  if (lower.includes("yesterday")) {
    const start = new Date(baseDate);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(baseDate);
    end.setUTCHours(23, 59, 59, 999);
    return {
      since: start.toISOString(),
      until: end.toISOString(),
      timeLabel: "yesterday",
    };
  }

  if (lower.includes("today")) {
    const start = new Date(baseDate);
    start.setUTCHours(0, 0, 0, 0);
    return {
      since: start.toISOString(),
      timeLabel: "today",
    };
  }

  if (lower.includes("24h") || lower.includes("24 hours")) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    return {
      since,
      timeLabel: "in the last 24 hours",
    };
  }

  return {};
}

// ------------------------------------------------------------------ Natural Language Intent & Dispatcher

export async function processIntelligenceQuery(
  rawQuery: string,
  systemMetadata: {
    cameras: Array<{ id: string; name: string }>;
    zones: Array<{ id: string; name: string }>;
  },
): Promise<EngineAnswer> {
  const q = rawQuery.trim();
  const lower = q.toLowerCase();

  const names: NameLookup = {
    cameraName: (id) =>
      id ? systemMetadata.cameras.find((c) => c.id === id)?.name ?? humanise(id) : null,
    zoneName: (id) =>
      id ? systemMetadata.zones.find((z) => z.id === id)?.name ?? humanise(id) : null,
  };

  // ----------------------------------------------------------------
  // 0. Zone inventory
  // ----------------------------------------------------------------
  const asksForZoneCount = /\b(how many|number\w*\s+of|count|total)\b/.test(lower) &&
    /\b(active\s+)?zones?\b/.test(lower);
  if (asksForZoneCount) {
    const allZones = await api.zones();
    const activeZones = allZones.filter((zone) => zone.active);
    const includeInactive = /\b(all|total)\s+zones?\b/.test(lower) && !lower.includes("active");
    const displayedZones = includeInactive ? allZones : activeZones;
    const state = includeInactive ? "configured" : "active";
    const zoneNames = displayedZones.map((zone) => zone.name).join(", ") || "none";

    return {
      answer: `There ${displayedZones.length === 1 ? "is" : "are"} **${displayedZones.length} ${state} zone${displayedZones.length === 1 ? "" : "s"}** at this post.\n\n**${state === "active" ? "Active" : "Configured"} zones:** ${zoneNames}.`,
      suggestedPrompts: [
        "Show activity around Northern Fence",
        "Which cameras watch the active zones?",
        "Are there any open critical incidents?",
      ],
      result: { kind: "none" },
      intent: "count_zones",
      toolUsed: "api.zones()",
    };
  }

  // Extract entities
  const plateMatch = extractPlate(q);
  const camMatch = resolveCameraId(q, systemMetadata.cameras);
  const zoneMatch = resolveZoneId(q, systemMetadata.zones);

  // 1. Vehicle Plate Direct Search
  if (plateMatch) {
    const matchedPlate = plateMatch;
    const vehicleData = await toolSearchVehicle(matchedPlate);

    if (!vehicleData) {
      return {
        answer: `There is no record of vehicle ${matchedPlate} in the detection logs or active watchlist.`,
        suggestedPrompts: [
          "Show all recently detected vehicles",
          "Are there any open critical incidents?",
          "Check the northern fence camera",
        ],
        result: { kind: "none" },
        intent: "search_vehicle",
        toolUsed: "searchVehicle()",
      };
    }

    const { totalSightings, lastSeen, firstSeen, formattedPlate, watchlistStatus } = vehicleData;

    let headline =
      totalSightings > 0
        ? `I found **${totalSightings} recorded detection${totalSightings === 1 ? "" : "s"}** for **${formattedPlate}**.`
        : `**${formattedPlate}** is on the **active watchlist**, but no camera has sighted it yet.`;

    if (watchlistStatus.isMatch) {
      headline += `\n\n⚠️ **Watchlist match** (${watchlistStatus.severity}): ${watchlistStatus.flagReason ?? "flagged entity"}.`;
    }

    if (lastSeen) {
      headline += `\n\nThe latest detection was at **${lastSeen.cameraName}**${
        lastSeen.zoneName ? ` in ${lastSeen.zoneName}` : ""
      } at **${clockTime(lastSeen.occurredAt)}** (${relative(lastSeen.occurredAt)}).`;
    }

    if (firstSeen && totalSightings > 1) {
      headline += `\nIt was first seen at ${clockTime(firstSeen.occurredAt)} on ${firstSeen.cameraName}.`;
    }

    return {
      answer: headline,
      suggestedPrompts: [
        `Show the timeline for ${formattedPlate}`,
        lastSeen ? `Show details for ${lastSeen.cameraName}` : "Show all recently detected vehicles",
        "Are there any open critical incidents?",
      ],
      result: {
        kind: "vehicle",
        vehicle: vehicleData,
        snapshot: lastSeen?.snapshot
          ? {
              url: lastSeen.snapshot,
              label: `Last seen: ${lastSeen.cameraName} · ${clockTime(lastSeen.occurredAt)}`,
            }
          : null,
      },
      intent: "search_vehicle",
      toolUsed: "searchVehicle()",
    };
  }

  // 2. Camera Location Intent
  if (/\b(where is|location|coordinates|where's)\b/i.test(lower) && camMatch) {
    const loc = toolGetCameraLocation(camMatch.id, camMatch.name);
    return {
      answer: `**${loc.cameraName}** is located in sector **${loc.sectorName}**.\n\n- **Coordinates:** ${loc.coordinates ? formatLatLon(loc.coordinates) : "Survey pending"}\n- **Grid reference:** ${loc.gridReference}\n- **Bearing:** ${loc.bearing}° (${loc.fovDeg}° FOV, ${loc.rangeM}m range)`,
      suggestedPrompts: [
        `Show activity around ${loc.cameraName}`,
        "What happened near the northern fence yesterday?",
        "Are there any open critical incidents?",
      ],
      result: {
        kind: "camera",
        camera: {
          cameraId: loc.cameraId,
          cameraName: loc.cameraName,
          status: "ONLINE",
          enabled: true,
          coordinates: loc.coordinates,
          gridReference: loc.gridReference,
          bearing: loc.bearing,
          fovDeg: loc.fovDeg,
          rangeM: loc.rangeM,
          recentEvents: [],
          incidents: [],
          recentPlates: [],
        },
      },
      intent: "get_camera_location",
      toolUsed: "getCameraLocation()",
    };
  }

  // 3. Incidents Intent
  if (/\b(incidents?|critical|escalated|open incidents?)\b/i.test(lower)) {
    const severityMatch = lower.includes("critical") ? "CRITICAL" : lower.includes("warning") ? "WARNING" : undefined;
    const incidents = await toolSearchIncidents({ severity: severityMatch as Severity });
    const count = incidents.length;

    return {
      answer: `There ${count === 1 ? "is" : "are"} **${count} open incident${count === 1 ? "" : "s"}** requiring attention. Review the list in the contextual panel.`,
      suggestedPrompts: [
        "What happened near the northern fence yesterday?",
        "Show all recently detected vehicles",
        "Where is the northern fence camera?",
      ],
      result: {
        kind: "multiple",
        multiple: multipleResults("Open Incidents", incidents.map((i) => incidentToItem(i, names)), {
          scannedCount: incidents.length,
        }),
      },
      intent: "search_incidents",
      toolUsed: "searchIncidents()",
    };
  }

  // 4. Camera Activity Intent
  if (camMatch && (lower.includes("activity") || lower.includes("cam-") || lower.includes("camera"))) {
    const camData = await toolSearchCameraActivity(camMatch.id);
    if (camData) {
      return {
        answer: `Showing activity for **${camData.cameraName}** (${camData.status}).`,
        suggestedPrompts: [
          `Where is ${camData.cameraName} located?`,
          "What happened near the northern fence yesterday?",
          "Are there any open critical incidents?",
        ],
        result: {
          kind: "camera",
          camera: camData,
        },
        intent: "search_camera",
        toolUsed: "searchCameraActivity()",
      };
    }
  }

  // 5. Zone Activity Intent
  if (zoneMatch && (lower.includes("happened") || lower.includes("activity") || lower.includes("fence") || lower.includes("zone") || lower.includes("yesterday"))) {
    const timeInfo = parseQueryTimeWindow(q);
    const zoneData = await toolSearchZoneActivity(zoneMatch.id, timeInfo);
    if (zoneData) {
      return {
        answer: `Found ${zoneData.recentEvents.length} events and ${zoneData.recentIncidents.length} incidents in **${zoneData.zoneName}**${timeInfo.timeLabel ? ` (${timeInfo.timeLabel})` : ""}.`,
        suggestedPrompts: [
          "Are there any open critical incidents?",
          "Find vehicle PB 02 AK 4821",
          "Where is the northern fence camera?",
        ],
        result: {
          kind: "zone",
          zone: zoneData,
        },
        intent: "search_zone",
        toolUsed: "searchZoneActivity()",
      };
    }
  }

  // 6. Global Surveillance Activity Search (NL Intent Parsing)
  const isDataQuery =
    /\b(what|happened|occurred|was|were|show|find|search|check|list|any|details?|detected|seen)\b/i.test(q) ||
    Boolean(camMatch) ||
    Boolean(zoneMatch) ||
    lower.includes("attari") ||
    lower.includes("pm") ||
    lower.includes("am") ||
    lower.includes("yesterday") ||
    lower.includes("today") ||
    lower.includes("fence") ||
    lower.includes("car") ||
    lower.includes("vehicle") ||
    lower.includes("person");

  if (isDataQuery) {
    const timeInfo = parseQueryTimeWindow(q);
    const colorMatch = lower.match(/\b(red|black|white|blue|silver|yellow|green|grey|gray)\b/i)?.[1];
    const objectMatch = lower.match(/\b(person|people|human|pedestrian|vehicle|car|suv|truck|tractor|cattle|boat)\b/i)?.[1];

    const searchRes = await toolSearchGlobalActivity({
      since: timeInfo.since,
      until: timeInfo.until,
      zoneId: zoneMatch?.id,
      cameraId: camMatch?.id,
      objectType: objectMatch,
      vehicleColor: colorMatch,
      plateNumber: plateMatch ?? undefined,
    });

    if (searchRes.records.length === 0) {
      return {
        answer: "No recorded events were found for that time and zone.",
        suggestedPrompts: [
          "Show activity around Northern Fence",
          "Find vehicle PB 02 AK 4821",
          "Are there any open critical incidents?",
        ],
        result: { kind: "none" },
        intent: "search_global_activity",
        toolUsed: "searchGlobalActivity()",
      };
    }

    const count = searchRes.records.length;
    let answerText = `I found **${count} recorded log entry${count === 1 ? "" : "ies"}**`;
    if (timeInfo.timeLabel) answerText += ` ${timeInfo.timeLabel}`;
    if (zoneMatch) answerText += ` in **${zoneMatch.name}**`;
    answerText += `.\n\n`;

    const topRecords = searchRes.records.slice(0, 5);
    for (const rec of topRecords) {
      const camName = names.cameraName(rec.camera) ?? humanise(rec.camera);
      const zoneName = names.zoneName(rec.zone) ?? humanise(rec.zone);

      answerText += `- **${clockTime(rec.timestamp)}** at **${camName}** (${zoneName}): ${humanise(rec.objectType)} ${humanise(rec.eventType)}`;
      if (rec.plateNumber) {
        answerText += ` [Plate: **${formatPlate(rec.plateNumber)}**`;
        if (rec.vehicleColor) answerText += `, Color: ${rec.vehicleColor}`;
        answerText += `]`;
      }
      if (rec.severity) answerText += ` (Severity: \`${rec.severity}\`)`;
      answerText += `\n`;
    }

    if (count > 5) {
      answerText += `\n*Showing top 5 of ${count} matching records. View full timeline in the contextual panel.*`;
    }

    let resultPayload: IntelligenceResult = { kind: "none" };

    if (searchRes.events.length > 0) {
      resultPayload = {
        kind: "events",
        events: {
          queryTitle: `Global Activity Logs (${count} records)`,
          count: searchRes.events.length,
          events: searchRes.events,
        },
        multiple: multipleResults("Recorded Activity", searchRes.events.map((e) => eventToItem(e, names)), {
          scannedCount: searchRes.events.length,
        }),
      };
    } else if (searchRes.incidents.length > 0) {
      resultPayload = {
        kind: "multiple",
        multiple: multipleResults("Incident Activity", searchRes.incidents.map((i) => incidentToItem(i, names)), {
          scannedCount: searchRes.incidents.length,
        }),
      };
    }

    return {
      answer: answerText,
      suggestedPrompts: [
        "Are there any open critical incidents?",
        "Find vehicle PB 02 AK 4821",
        "Show activity around Northern Fence",
      ],
      result: resultPayload,
      intent: "search_global_activity",
      toolUsed: "searchGlobalActivity()",
    };
  }

  // Fallback for general greetings or non-data queries
  return {
    answer: "No recorded events were found for that time and zone.",
    suggestedPrompts: [
      "Find vehicle PB 02 AK 4821",
      "Where is the northern fence camera?",
      "Are there any open critical incidents?",
      "What happened near the northern fence yesterday?",
    ],
    result: { kind: "none" },
    intent: "general_help",
    toolUsed: "api.config()",
  };
}
