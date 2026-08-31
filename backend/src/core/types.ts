/** Shared vocabulary. Everything force-specific is a value here, never a code path. */

export type Severity = "INFO" | "WARNING" | "CRITICAL";

export const SEVERITY_RANK: Record<Severity, number> = {
  INFO: 0,
  WARNING: 1,
  CRITICAL: 2,
};

/** A zone's label. A fence line and a jetty perimeter are the same primitive. */
export type ZoneKind =
  | "fence_line"
  | "gate"
  | "waterline"
  | "perimeter"
  | "pass"
  | "restricted_area";

export type ZoneGeometry = "line" | "polygon";

/** Which way the subject went through the zone. Outbound and inbound are different events. */
export type Direction = "inbound" | "outbound";

export type CameraStatus = "FULL" | "DEGRADED" | "MOTION_ONLY" | "RECORD_ONLY" | "DEAD";

export type SourceType = "camera" | "external_sensor" | "operator" | "peer_node";

export type Role = "operator" | "supervisor" | "admin";

/** Normalised against the frame, so zones survive a camera swap. */
export type Point = [number, number];

export interface Zone {
  id: string;
  camera_id: string;
  org_id: string;
  name: string;
  kind: ZoneKind;
  geometry: ZoneGeometry;
  points: Point[];
  watch_classes: string[];
  log_only_classes: string[];
  direction: Direction | "both";
  confirm_seconds: number;
  severity: Severity;
  active: boolean;
}

/** One detection as it arrives at the ingress hook. */
export interface Detection {
  track_ref: string;
  class: string;
  confidence: number;
  /** [x, y, w, h], normalised 0..1. */
  bbox: [number, number, number, number];
}

export interface DetectionFrame {
  camera_id: string;
  occurred_at: string;
  simulated: boolean;
  source_id: string;
  detections: Detection[];
}

export interface Actor {
  id: string;
  name: string;
  role: Role;
}

/** Verbs that change an incident's state. The state is derived from these alone. */
export const INCIDENT_STATE_VERBS = [
  "incident.acknowledge",
  "incident.escalate",
  "incident.dismiss",
] as const;

/** Verbs that must carry a stated reason. */
export const REASON_REQUIRED_VERBS = new Set<string>([
  "incident.escalate",
  "incident.dismiss",
  "zone.delete",
]);
