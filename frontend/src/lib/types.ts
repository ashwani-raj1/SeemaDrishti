/**
 * The vocabulary, mirrored from backend/src/core/types.ts.
 *
 * Kept as a hand-written mirror rather than an import: the two packages build
 * separately and the backend is the authority. If they drift, the API layer
 * fails loudly at the boundary rather than silently rendering wrong.
 */

export type Severity = "INFO" | "WARNING" | "CRITICAL";

export const SEVERITY_RANK: Record<Severity, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };

/** A zone's label. A fence line and a jetty perimeter are the same primitive. */
export type ZoneKind =
  | "fence_line"
  | "gate"
  | "waterline"
  | "perimeter"
  | "pass"
  | "restricted_area";

export type ZoneGeometry = "line" | "polygon";
export type Direction = "inbound" | "outbound";

/** The blindness ladder (Plate 07), worst-last. */
export type CameraStatus = "FULL" | "DEGRADED" | "MOTION_ONLY" | "RECORD_ONLY" | "DEAD";

export const CAMERA_STATUS_ORDER: CameraStatus[] = [
  "FULL",
  "DEGRADED",
  "MOTION_ONLY",
  "RECORD_ONLY",
  "DEAD",
];

export type SourceType = "camera" | "external_sensor" | "operator" | "peer_node";
export type Role = "operator" | "supervisor" | "admin";

/** Normalised 0..1 against the frame, so a zone survives a camera swap. */
export type Point = [number, number];

export type IncidentStatus = "OPEN" | "ACKNOWLEDGED" | "ESCALATED" | "DISMISSED";

export type Decision = "acknowledge" | "escalate" | "dismiss";

// ---------------------------------------------------------------- API shapes

export interface Zone {
  id: string;
  cameraId: string;
  name: string;
  kind: ZoneKind;
  geometry: ZoneGeometry;
  points: Point[];
  watchClasses: string[];
  logOnlyClasses: string[];
  direction: Direction | "both";
  confirmSeconds: number;
  severity: Severity;
  active: boolean;
  updatedAt: string;
}

export interface Camera {
  id: string;
  name: string;
  status: CameraStatus;
  zones: Zone[];
}

export interface Organisation {
  id: string;
  name: string;
  code: string;
  retention_days: number;
  created_at: string;
}

export interface Site {
  id: string;
  org_id: string;
  name: string;
  kind: string;
  created_at: string;
}

export interface AppUser {
  id: string;
  name: string;
  role: Role;
}

export interface ServerConfig {
  org: Organisation;
  site: Site;
  users: AppUser[];
  cameras: Camera[];
}

/** What the explain overlay (#21) draws from. All coordinates normalised 0..1. */
export interface Evidence {
  zone?: {
    id: string;
    name: string;
    kind: ZoneKind;
    geometry: ZoneGeometry;
    points: Point[];
  };
  crossedAt?: Point;
  path?: Point[];
  bbox?: [number, number, number, number];
  trackRef?: string;
  camera?: string;
  /** What the zone demanded before it would shout (#13). */
  confirmSeconds?: number;
  /** What the track actually held for. Shown side by side with the above. */
  heldSeconds?: number;
  [key: string]: unknown;
}

export interface IbvapEvent {
  seq: number;
  id: string;
  kind: string;
  source: { type: SourceType; id: string; simulated: boolean };
  cameraId: string | null;
  zoneId: string | null;
  trackedThingId: string | null;
  class: string | null;
  direction: Direction | null;
  rule: string | null;
  confidence: number | null;
  severity: Severity;
  /** false means: written to the log, never raised to a human. */
  alertable: boolean;
  suppressedReason: string | null;
  occurredAt: string;
  receivedAt: string;
  evidence: Evidence;
}

export interface Incident {
  id: string;
  title: string;
  severity: Severity;
  status: IncidentStatus;
  cameraId: string | null;
  zoneId: string | null;
  openedAt: string;
  lastEventAt: string;
  eventCount: number;
}

export interface Action {
  seq: number;
  id: string;
  actor: { id: string; name: string; role: Role };
  verb: string;
  target: { type: string; id: string | null };
  reason: string | null;
  detail: Record<string, unknown>;
  before: unknown;
  after: unknown;
  at: string;
  hash: string;
}

export interface IncidentDetail {
  incident: Incident;
  events: IbvapEvent[];
  actions: Action[];
}

export interface SimStatus {
  running: boolean;
  ambient: boolean;
  walkers: number;
  scenarios: string[];
}

export interface Health {
  ok: boolean;
  at: string;
  liveTracks: number;
  streamSubscribers: number;
  simulator: SimStatus;
}

/** The audit chain check. `ok:false` names the first row that broke. */
export interface ChainVerdict {
  ok: boolean;
  checked: number;
  brokenAt?: number | null;
  [key: string]: unknown;
}
