/**
 * The controlled tool registry for the intelligence assistant.
 *
 * These are the ONLY things the model is allowed to ask for. It never sees a
 * connection string, never writes SQL, and never reaches the database except
 * through the functions below -- each of which is an existing L3 query with a
 * bounded result size.
 *
 * Two views of every result, and the difference matters:
 *   - the full result goes back to the browser so the evidence panel can show
 *     the snapshot and the complete timeline;
 *   - `redactForModel` strips base64 images and caps arrays before anything is
 *     handed to Gemini. A single detection snapshot is a data URL, and feeding
 *     those to a language model would blow the context window on pixels the
 *     model cannot use anyway.
 *
 * Geography is deliberately absent. Camera coordinates, bearings and grid
 * references are deployment configuration that lives in the frontend
 * (client/geography.ts); the node does not know them, so it cannot invent them.
 */
import { DEFAULT_ORG, DEFAULT_SITE } from "../db/seed";
import { cameraDetail, listCameras } from "../l3/cameras";
import { crossReference, getIncident, listIncidents, queryEvents } from "../l3/events";
import { actionsFor } from "../l3/audit";
import {
  findWatchlistMatch,
  normalizePlate,
  queryPlateDetections,
} from "../l3/watchlist";
import { listZones } from "../l3/zones";
import type { Severity } from "../core/types";

/** How much of any one list the model is allowed to reason over. */
const MODEL_ARRAY_CAP = 12;
/** Hard ceiling on records a single tool call may return to the browser. */
const RESULT_CAP = 100;

const clamp = (value: unknown, fallback: number) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), RESULT_CAP);
};

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

// ------------------------------------------------------------------ tool results

export interface VehicleEvidence {
  plateNumber: string;
  totalSightings: number;
  firstSeen: { occurredAt: string; cameraId: string; cameraName: string | null; zoneName: string | null } | null;
  lastSeen: {
    occurredAt: string;
    cameraId: string;
    cameraName: string | null;
    zoneName: string | null;
    snapshot: string | null;
  } | null;
  watchlist: {
    isMatch: boolean;
    severity: Severity | null;
    flagReason: string | null;
    notes: string | null;
    vehicleType: string | null;
    makeModel: string | null;
    color: string | null;
  };
  camerasVisited: Array<{ cameraId: string; cameraName: string; count: number; lastSeenAt: string }>;
  timeline: Array<{
    detectionId: string;
    cameraId: string;
    cameraName: string | null;
    zoneId: string | null;
    zoneName: string | null;
    occurredAt: string;
    confidence: number;
    matchStatus: string;
    severity: Severity;
    snapshot: string | null;
  }>;
}

/**
 * One tool result as the browser receives it: what kind of evidence this is,
 * and the full unredacted payload behind it.
 */
export interface EvidenceRecord {
  kind: EvidenceKind;
  args: Record<string, unknown>;
  result: unknown;
}

// ------------------------------------------------------------------ tools

function searchVehicle(args: Record<string, unknown>): VehicleEvidence | null {
  const raw = str(args.plate);
  if (!raw) return null;
  const plate = normalizePlate(raw);
  if (!plate) return null;

  // Ordered occurred_at DESC by the query, so [0] is the latest sighting.
  const detections = queryPlateDetections(DEFAULT_ORG, { plateNumber: plate, limit: RESULT_CAP });
  const watchlistHit = findWatchlistMatch(DEFAULT_ORG, plate);
  if (detections.length === 0 && !watchlistHit) return null;

  const cameraNames = new Map(
    listCameras(DEFAULT_SITE).map((camera) => [camera.id, camera.name]),
  );
  const nameOf = (row: any, cameraId: string) => row?.camera_name ?? cameraNames.get(cameraId) ?? null;

  const visits = new Map<string, { cameraId: string; cameraName: string; count: number; lastSeenAt: string }>();
  for (const d of detections) {
    const existing = visits.get(d.camera_id) ?? {
      cameraId: d.camera_id,
      cameraName: nameOf(d, d.camera_id) ?? d.camera_id,
      count: 0,
      lastSeenAt: d.occurred_at,
    };
    existing.count += 1;
    visits.set(d.camera_id, existing);
  }

  const latest = detections[0] ?? null;
  const earliest = detections.length ? detections[detections.length - 1]! : null;
  const entry = watchlistHit?.entry ?? null;

  return {
    plateNumber: plate,
    totalSightings: detections.length,
    firstSeen: earliest
      ? {
          occurredAt: earliest.occurred_at,
          cameraId: earliest.camera_id,
          cameraName: nameOf(earliest, earliest.camera_id),
          zoneName: earliest.zone_name ?? null,
        }
      : null,
    lastSeen: latest
      ? {
          occurredAt: latest.occurred_at,
          cameraId: latest.camera_id,
          cameraName: nameOf(latest, latest.camera_id),
          zoneName: latest.zone_name ?? null,
          snapshot: latest.image_snapshot ?? null,
        }
      : null,
    watchlist: {
      isMatch: Boolean(entry) || latest?.match_status === "MATCHED",
      severity: entry?.severity ?? null,
      flagReason: entry?.flag_reason ?? null,
      notes: entry?.notes ?? null,
      vehicleType: entry?.vehicle_type ?? latest?.vehicle_type ?? null,
      makeModel: entry?.make_model ?? null,
      color: entry?.color ?? null,
    },
    camerasVisited: [...visits.values()],
    timeline: detections.map((d) => ({
      detectionId: d.id,
      cameraId: d.camera_id,
      cameraName: nameOf(d, d.camera_id),
      zoneId: d.zone_id ?? null,
      zoneName: d.zone_name ?? null,
      occurredAt: d.occurred_at,
      confidence: d.confidence,
      matchStatus: d.match_status,
      severity: d.severity,
      snapshot: d.image_snapshot ?? null,
    })),
  };
}

function searchEvents(args: Record<string, unknown>) {
  return queryEvents(DEFAULT_ORG, {
    class: str(args.class),
    cameraId: str(args.cameraId),
    zoneId: str(args.zoneId),
    severity: str(args.severity) as Severity | undefined,
    since: str(args.since),
    until: str(args.until),
    limit: clamp(args.limit, 50),
  });
}

function searchIncidents(args: Record<string, unknown>) {
  const severity = str(args.severity);
  const incidents = listIncidents(DEFAULT_ORG, {
    status: str(args.status),
    cameraId: str(args.cameraId),
    zoneId: str(args.zoneId),
    limit: clamp(args.limit, 50),
  });
  // listIncidents has no severity column filter; ranking already puts the
  // worst first, so narrowing here costs nothing and stays correct.
  return severity ? incidents.filter((i) => i.severity === severity) : incidents;
}

function incidentEvidence(args: Record<string, unknown>) {
  const incidentId = str(args.incidentId);
  if (!incidentId) return null;
  const incident = getIncident(incidentId);
  if (!incident) return null;
  return {
    incident,
    events: queryEvents(DEFAULT_ORG, { incidentId, limit: MODEL_ARRAY_CAP * 4 }),
    actions: actionsFor("incident", incidentId),
    crossReference: crossReference(incidentId),
  };
}

function cameraEvidence(args: Record<string, unknown>) {
  const cameraId = str(args.cameraId);
  if (!cameraId) return null;
  const detail = cameraDetail(cameraId);
  if (!detail) return null;
  return {
    camera: detail,
    recentEvents: queryEvents(DEFAULT_ORG, { cameraId, limit: MODEL_ARRAY_CAP }),
    incidents: listIncidents(DEFAULT_ORG, { cameraId, limit: MODEL_ARRAY_CAP }),
    recentPlates: queryPlateDetections(DEFAULT_ORG, { cameraId, limit: MODEL_ARRAY_CAP }),
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
}

function searchGlobalActivity(args: Record<string, unknown>): {
  records: GlobalActivityRecord[];
  totalCount: number;
} {
  const zone = str(args.zone);
  const camera = str(args.camera);
  const since = str(args.since || args.startTime);
  const until = str(args.until || args.endTime);
  const objectType = str(args.objectType);
  const eventType = str(args.eventType);
  const plateNumber = str(args.plateNumber || args.plate);
  const vehicleColor = str(args.vehicleColor || args.color);
  const severity = str(args.severity) as Severity | undefined;
  const limit = clamp(args.limit, 50);

  const events = queryEvents(DEFAULT_ORG, {
    class: objectType,
    cameraId: camera,
    zoneId: zone,
    severity,
    since,
    until,
    limit,
  });

  const plates = queryPlateDetections(DEFAULT_ORG, {
    plateNumber: plateNumber ? normalizePlate(plateNumber) : undefined,
    cameraId: camera,
    zoneId: zone,
    limit,
  });

  const incidents = listIncidents(DEFAULT_ORG, {
    cameraId: camera,
    zoneId: zone,
    limit,
  });

  const records: GlobalActivityRecord[] = [];

  for (const e of events) {
    const t = new Date(e.occurredAt || e.receivedAt).getTime();
    if (since && t < new Date(since).getTime()) continue;
    if (until && t > new Date(until).getTime()) continue;

    const obj = (e.class || "object").toLowerCase();
    if (objectType && !obj.includes(objectType.toLowerCase())) continue;

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
    });
  }

  for (const p of plates) {
    const t = new Date(p.occurred_at).getTime();
    if (since && t < new Date(since).getTime()) continue;
    if (until && t > new Date(until).getTime()) continue;

    const color = p.matched_entry?.color ?? null;
    if (vehicleColor && color && !color.toLowerCase().includes(vehicleColor.toLowerCase())) {
      continue;
    }

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
    });
  }

  for (const inc of incidents) {
    const t = new Date(inc.openedAt || inc.lastEventAt).getTime();
    if (since && t < new Date(since).getTime()) continue;
    if (until && t > new Date(until).getTime()) continue;

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
    records: records.slice(0, limit),
    totalCount: records.length,
  };
}

// ------------------------------------------------------------------ registry

interface Tool {
  description: string;
  parameters: Record<string, unknown>;
  run: (args: Record<string, unknown>) => unknown;
}

const STRING = { type: "string" };
const PLATE = { ...STRING, description: "Vehicle registration plate, any spacing or dashes." };
const CAMERA = { ...STRING, description: "Exact camera id, e.g. cam_fence_north. Call list_cameras first if unsure." };
const ZONE = { ...STRING, description: "Exact zone id, e.g. zone_fence_line. Call list_zones first if unsure." };
const ISO = { ...STRING, description: "ISO-8601 timestamp." };

export const TOOLS: Record<string, Tool> = {
  search_global_activity: {
    description:
      "Global search across ALL real recorded surveillance logs (events, ANPR plate detections, incidents). Use for natural language questions about time, zone, camera, object, or vehicle color.",
    parameters: {
      type: "object",
      properties: {
        zone: ZONE,
        camera: CAMERA,
        since: ISO,
        until: ISO,
        startTime: ISO,
        endTime: ISO,
        objectType: { ...STRING, description: "Object type: person, vehicle, tractor, cattle, etc." },
        eventType: { ...STRING, description: "Event type: fence_crossing, intrusion, loitering, etc." },
        plateNumber: PLATE,
        vehicleColor: { ...STRING, description: "Vehicle color, e.g. red, black, blue, white" },
        severity: { type: "string", enum: ["INFO", "WARNING", "CRITICAL"] },
        limit: { type: "integer", description: "Maximum records, default 50." },
      },
    },
    run: searchGlobalActivity,
  },

  search_vehicle: {
    description:
      "Find every recorded sighting of a vehicle by number plate: total sightings, first and last seen, which cameras it passed, and whether it is on the watchlist.",
    parameters: {
      type: "object",
      properties: { plate: PLATE },
      required: ["plate"],
    },
    run: searchVehicle,
  },

  search_events: {
    description:
      "Query the recorded detection event log -- fence crossings, intrusions, person and vehicle movements. Filter by object class, camera, zone, severity and time range.",
    parameters: {
      type: "object",
      properties: {
        class: { ...STRING, description: "Object class: person, vehicle, cattle, boat, etc." },
        cameraId: CAMERA,
        zoneId: ZONE,
        severity: { type: "string", enum: ["INFO", "WARNING", "CRITICAL"] },
        since: ISO,
        until: ISO,
        limit: { type: "integer", description: "Maximum records, default 50." },
      },
    },
    run: searchEvents,
  },

  search_incidents: {
    description:
      "Query the operator incident queue. Incidents are grouped events that needed a human decision.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["OPEN", "ACKNOWLEDGED", "ESCALATED", "DISMISSED"] },
        severity: { type: "string", enum: ["INFO", "WARNING", "CRITICAL"] },
        cameraId: CAMERA,
        zoneId: ZONE,
        limit: { type: "integer", description: "Maximum records, default 50." },
      },
    },
    run: searchIncidents,
  },

  get_incident: {
    description: "Full detail for one incident: its events, the operator decisions taken, and what nearby cameras saw.",
    parameters: {
      type: "object",
      properties: { incidentId: { ...STRING, description: "Incident id, e.g. inc_abc123." } },
      required: ["incidentId"],
    },
    run: incidentEvidence,
  },

  get_camera: {
    description: "One camera's status plus its recent events, incidents and plate reads.",
    parameters: { type: "object", properties: { cameraId: CAMERA }, required: ["cameraId"] },
    run: cameraEvidence,
  },

  list_cameras: {
    description: "Every camera configured at this post, with id, name and service status.",
    parameters: { type: "object", properties: {} },
    run: () =>
      listCameras(DEFAULT_SITE).map((camera) => ({
        id: camera.id,
        name: camera.name,
        status: camera.status,
        enabled: camera.enabled,
      })),
  },

  list_zones: {
    description: "Every monitored zone at this post, with id, name, kind and the cameras watching it.",
    parameters: { type: "object", properties: {} },
    run: () => listZones(DEFAULT_SITE),
  },
};

/** The function declarations handed to Gemini. */
export const toolDeclarations = () =>
  Object.entries(TOOLS).map(([name, tool]) => ({
    name,
    description: tool.description,
    parameters: tool.parameters,
  }));

export class ToolNotFound extends Error {
  constructor(name: string) {
    super(`unknown tool ${name}`);
    this.name = "ToolNotFound";
  }
}

/**
 * What a tool's output IS, in domain terms.
 *
 * The wire format carries this instead of the tool name. The tool registry is
 * an internal mechanism and renaming a tool should not ripple into the browser,
 * so callers key off the kind of evidence they received.
 */
export type EvidenceKind =
  | "vehicle"
  | "events"
  | "incidents"
  | "incident"
  | "camera"
  | "cameras"
  | "zones";

const EVIDENCE_KIND: Record<string, EvidenceKind> = {
  search_vehicle: "vehicle",
  search_events: "events",
  search_incidents: "incidents",
  get_incident: "incident",
  get_camera: "camera",
  list_cameras: "cameras",
  list_zones: "zones",
};

export const evidenceKind = (tool: string): EvidenceKind => EVIDENCE_KIND[tool] ?? "events";

/** Runs one model-requested tool. Throws rather than guessing on an unknown name. */
export function executeTool(name: string, args: Record<string, unknown>): unknown {
  const tool = TOOLS[name];
  if (!tool) throw new ToolNotFound(name);
  return tool.run(args ?? {});
}

// ------------------------------------------------------------------ redaction

/** Recursively replaces base64 image payloads with a flag the model can mention. */
function stripImages(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripImages);
  if (!value || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if ((key === "image_snapshot" || key === "snapshot" || key === "evidence") && typeof entry === "string") {
      if (entry.startsWith("data:")) {
        out.hasImage = true;
        continue;
      }
    }
    out[key] = stripImages(entry);
  }
  return out;
}

function capArrays(value: unknown): unknown {
  if (Array.isArray(value)) {
    const capped = value.slice(0, MODEL_ARRAY_CAP).map(capArrays);
    return value.length > MODEL_ARRAY_CAP
      ? { items: capped, totalRecords: value.length, note: `showing first ${MODEL_ARRAY_CAP} of ${value.length}` }
      : capped;
  }
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = capArrays(entry);
  return out;
}

/**
 * What the model is allowed to read. Bounded on purpose: an operator question
 * should cost a predictable number of tokens no matter how busy the post has
 * been, and no snapshot bytes ever leave this process on the way to Gemini.
 */
export function redactForModel(result: unknown): unknown {
  return capArrays(stripImages(result));
}
