/**
 * The one shape both intelligence modes produce.
 *
 * AI chat and Manual Search reach their answers by completely different routes
 * -- one through a model driving a tool registry, one through filter controls
 * hitting the API directly -- but the evidence panel should not be able to tell
 * them apart. Everything here is that shared contract: a discriminated result
 * the panel renders, and the shapers that turn raw API payloads into it.
 *
 * Nothing in this file talks to the network. It is pure transformation, which
 * is what makes it testable and what stops the two modes drifting apart.
 */
import { formatPlate, humanise } from "@/lib/format";
import type { GeoPoint } from "@/client/geography";
import type {
  Incident,
  IncidentDetail,
  IbvapEvent,
  PlateDetection,
  Severity,
  WatchlistEntry,
} from "@/lib/types";

// ------------------------------------------------------------------ context payloads

export interface VehicleTimelineItem {
  detectionId: string;
  cameraId: string;
  cameraName: string;
  zoneId: string | null;
  zoneName: string | null;
  occurredAt: string;
  confidence: number;
  matchStatus: "MATCHED" | "CLEAR" | "UNVERIFIED";
  severity: Severity;
  snapshot: string | null;
  coordinates?: GeoPoint | null;
}

export interface VehicleContextData {
  plateNumber: string;
  formattedPlate: string;
  vehicleType: string;
  makeModel?: string | null;
  color?: string | null;
  confidence: number;
  totalSightings: number;
  firstSeen: {
    occurredAt: string;
    cameraId: string;
    cameraName: string;
    zoneName: string | null;
  } | null;
  lastSeen: {
    occurredAt: string;
    cameraId: string;
    cameraName: string;
    zoneName: string | null;
    snapshot: string | null;
    coordinates?: GeoPoint | null;
    gridReference?: string;
  } | null;
  watchlistStatus: {
    isMatch: boolean;
    flagReason?: string | null;
    severity?: Severity;
    notes?: string | null;
    entry?: WatchlistEntry | null;
  };
  timeline: VehicleTimelineItem[];
  camerasVisited: Array<{
    cameraId: string;
    cameraName: string;
    count: number;
    lastSeenAt: string;
  }>;
  relatedIncidents: Incident[];
  relatedEvents: IbvapEvent[];
  /** Dynamic unmapped fields for future-proofing */
  extraFields: Record<string, unknown>;
}

export interface CameraContextData {
  cameraId: string;
  cameraName: string;
  status: string;
  enabled: boolean;
  coordinates: GeoPoint | null;
  gridReference: string;
  bearing: number;
  fovDeg: number;
  rangeM: number;
  recentEvents: IbvapEvent[];
  incidents: Incident[];
  recentPlates: PlateDetection[];
}

export interface ZoneContextData {
  zoneId: string;
  zoneName: string;
  kind: string;
  sector: string | null;
  active: boolean;
  camerasWatching: string[];
  recentEvents: IbvapEvent[];
  recentIncidents: Incident[];
}

export interface IncidentContextData {
  incident: Incident;
  detail?: IncidentDetail | null;
  cameraName?: string;
  coordinates?: GeoPoint | null;
  gridReference?: string;
  events: IbvapEvent[];
  /** Results from an incident-list query, used by the compact issue rail. */
  relatedIncidents?: Incident[];
  actions: Array<{
    actorName: string;
    verb: string;
    reason: string | null;
    at: string;
  }>;
}

export interface EventContextData {
  queryTitle: string;
  count: number;
  events: IbvapEvent[];
  timeRange?: { since?: string; until?: string };
}

// ------------------------------------------------------------------ the shared result

export type ResultKind =
  | "vehicle"
  | "camera"
  | "zone"
  | "incident"
  | "events"
  | "multiple"
  | "none";

/** The buckets the result list can be narrowed to. */
export type FacetId = "all" | "people" | "vehicles" | "other";

/**
 * One row in a result list, whichever mode produced it.
 *
 * Deliberately flat and display-ready: the panel renders this without knowing
 * whether it came from an incident, an event or a plate detection.
 */
export interface ResultItem {
  id: string;
  facet: Exclude<FacetId, "all">;
  /** "Person inbound", "Flagged vehicle PB 02 AK 4821" */
  title: string;
  cameraId: string | null;
  cameraName: string | null;
  zoneId: string | null;
  zoneName: string | null;
  occurredAt: string;
  severity: Severity;
  direction: string | null;
  plate: string | null;
  snapshot: string | null;
  /** Incident queue state, when the item is an incident. */
  status?: string;
}

export interface MultipleResults {
  /** Heading above the list, e.g. "Detected Issues". */
  label: string;
  items: ResultItem[];
  /**
   * How many records were examined to produce this list.
   *
   * Some filters are applied in the browser because the endpoint does not
   * support them, so the operator needs to know the search was bounded rather
   * than believing it covered the whole record.
   */
  scannedCount: number;
  truncated: boolean;
}

export interface IntelligenceResult {
  kind: ResultKind;
  vehicle?: VehicleContextData;
  camera?: CameraContextData;
  zone?: ZoneContextData;
  incident?: IncidentContextData;
  events?: EventContextData;
  multiple?: MultipleResults;
  snapshot?: { url: string | null; label?: string } | null;
}

export const emptyResult = (): IntelligenceResult => ({ kind: "none" });

// ------------------------------------------------------------------ name resolution

/**
 * Turns the ids the database speaks into the names an operator reads.
 *
 * Injected rather than imported so this module stays free of React context and
 * network calls.
 */
export interface NameLookup {
  cameraName: (id: string | null | undefined) => string | null;
  zoneName: (id: string | null | undefined) => string | null;
}

export const noNames: NameLookup = {
  cameraName: (id) => (id ? humanise(id) : null),
  zoneName: (id) => (id ? humanise(id) : null),
};

/**
 * Whether a stored snapshot can actually be drawn.
 *
 * A detection whose picture was never kept carries a placeholder token in the
 * same field, and that token is an internal detail -- not something to hand to
 * an `<img>` or print as a caption.
 */
export const isImageUrl = (value: string | null | undefined): value is string =>
  typeof value === "string" && (value.startsWith("data:") || value.startsWith("http"));

// ------------------------------------------------------------------ shapers

const facetForClass = (klass: string | null | undefined, plate?: string | null): Exclude<FacetId, "all"> => {
  const value = (klass ?? "").toLowerCase();
  if (plate) return "vehicles";
  if (value.includes("person") || value.includes("people") || value.includes("human")) return "people";
  if (value.includes("vehicle") || value.includes("car") || value.includes("truck")) return "vehicles";
  return "other";
};

/** Incidents carry only a title, so the class has to be read back out of it. */
const facetForTitle = (title: string): Exclude<FacetId, "all"> => {
  const value = title.toLowerCase();
  if (value.includes("person") || value.includes("people") || value.includes("intrus")) return "people";
  if (value.includes("vehicle") || value.includes("plate") || value.includes("car")) return "vehicles";
  return "other";
};

const directionWord = (direction: string | null | undefined) => {
  const value = (direction ?? "").toLowerCase();
  if (value === "inbound" || value === "entry") return "inbound";
  if (value === "outbound" || value === "exit") return "outbound";
  return direction ? humanise(direction) : null;
};

export function incidentToItem(incident: Incident, names: NameLookup): ResultItem {
  return {
    id: incident.id,
    facet: facetForTitle(incident.title),
    title: incident.title,
    cameraId: incident.cameraId,
    cameraName: names.cameraName(incident.cameraId),
    zoneId: incident.zoneId,
    zoneName: names.zoneName(incident.zoneId),
    occurredAt: incident.lastEventAt,
    severity: incident.severity,
    direction: null,
    plate: null,
    snapshot: null,
    status: incident.status,
  };
}

export function eventToItem(event: IbvapEvent, names: NameLookup): ResultItem {
  const snapshot = (event.evidence as { image_snapshot?: string | null } | undefined)?.image_snapshot ?? null;
  const direction = directionWord(event.direction);
  const subject = humanise(event.class ?? "activity");
  return {
    id: event.id,
    facet: facetForClass(event.class),
    title: direction ? `${subject} ${direction}` : subject,
    cameraId: event.cameraId,
    cameraName: names.cameraName(event.cameraId),
    zoneId: event.zoneId,
    zoneName: names.zoneName(event.zoneId),
    occurredAt: event.occurredAt,
    severity: event.severity,
    direction,
    plate: null,
    snapshot,
  };
}

export function detectionToItem(detection: PlateDetection, names: NameLookup): ResultItem {
  const plate = detection.plate_number ? formatPlate(detection.plate_number) : null;
  const flagged = detection.match_status === "MATCHED";
  return {
    id: detection.id,
    facet: "vehicles",
    title: plate ? `${flagged ? "Flagged vehicle" : "Vehicle"} ${plate}` : "Unread plate",
    cameraId: detection.camera_id,
    cameraName: detection.camera_name ?? names.cameraName(detection.camera_id),
    zoneId: detection.zone_id ?? null,
    zoneName: detection.zone_name ?? names.zoneName(detection.zone_id),
    occurredAt: detection.occurred_at,
    severity: detection.severity,
    direction: null,
    plate,
    snapshot: detection.image_snapshot ?? null,
  };
}

/** Most severe first, then most recent -- the order an operator scans in. */
const SEVERITY_ORDER: Record<Severity, number> = { CRITICAL: 0, WARNING: 1, INFO: 2 };

export function sortItems(items: ResultItem[]): ResultItem[] {
  return [...items].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return b.occurredAt.localeCompare(a.occurredAt);
  });
}

export function facetCounts(items: ResultItem[]): Array<{ id: FacetId; label: string; count: number }> {
  return [
    { id: "all", label: "All", count: items.length },
    { id: "people", label: "People", count: items.filter((i) => i.facet === "people").length },
    { id: "vehicles", label: "Vehicles", count: items.filter((i) => i.facet === "vehicles").length },
    { id: "other", label: "Other", count: items.filter((i) => i.facet === "other").length },
  ];
}

export function multipleResults(
  label: string,
  items: ResultItem[],
  meta: { scannedCount?: number; truncated?: boolean } = {},
): MultipleResults {
  return {
    label,
    items: sortItems(items),
    scannedCount: meta.scannedCount ?? items.length,
    truncated: meta.truncated ?? false,
  };
}
