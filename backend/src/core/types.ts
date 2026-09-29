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

/** What a target does when it matches. */
export type TargetAction = "alert" | "log_only";

/**
 * One thing this place must be detected against.
 *
 * `priority` is an explicit rank, 1 highest: the order the operator declared
 * these matter in, and the order they are read back in. It does not pick
 * between targets -- a detection carries one class and each class appears once
 * per scope -- it ranks them. `log_only` is the animal case: written down,
 * never alerted.
 */
export interface ZoneTarget {
  class: string;
  severity: Severity;
  action: TargetAction;
  priority: number;
  /** True when a camera-specific row overrode the zone's own policy. */
  overridden?: boolean;
}

/**
 * A zone as one camera sees it.
 *
 * The logical zone spans cameras; the shape does not, because a polygon drawn
 * in one camera's frame is meaningless in another's. So this is the resolved
 * pairing: the zone's identity, this camera's shape, and the effective target
 * list after any camera overrides are applied.
 *
 * `id` is the logical zone id, because that is what events reference and what
 * incidents group by. `bindingId` identifies the pairing itself.
 */
export interface Zone {
  id: string;
  bindingId: string;
  camera_id: string;
  org_id: string;
  site_id: string;
  name: string;
  kind: ZoneKind;
  geometry: ZoneGeometry;
  points: Point[];
  direction: Direction | "both";
  confirm_seconds: number;
  /** Ordered by priority ascending. */
  targets: ZoneTarget[];
  active: boolean;
  /**
   * False until a supervisor has positioned this shape against this camera's
   * view -- until then it is the stock placeholder handed out when the camera
   * joined the zone, and nobody chose where it sits.
   *
   * A crossing of an unplaced shape is evidence, never an alarm. See
   * `isProvisional` in l3/zones.ts and vision-service/CLAUDE.md section 15.
   */
  placed: boolean;
}

/** One detection as it arrives at the ingress hook. */
export interface Detection {
  track_ref: string;
  class: string;
  confidence: number;
  /** [x, y, w, h], normalised 0..1. */
  bbox: [number, number, number, number];
  /** Vehicle subtype supplied by the vision service, when class is vehicle. */
  vehicle_type?: string;
  /** A successful ANPR read, with a normalised plate box. */
  plate?: {
    text: string;
    confidence: number;
    bbox: [number, number, number, number];
  };
}

export interface DetectionFrame {
  camera_id: string;
  occurred_at: string;
  simulated: boolean;
  source_id: string;
  detections: Detection[];
  /**
   * A monotonic capture clock, in seconds, from whatever produced this frame.
   *
   * Wait-and-confirm measures how long a crossing has been held by
   * differencing these. Wall clock cannot be used for that: a post with no
   * NTP will step its clock, and a step makes a pending crossing either
   * confirm instantly or never confirm at all -- silently defeating the whole
   * seconds-not-frames design.
   *
   * The origin is arbitrary and producer-specific (seconds since that
   * machine booted, typically). Only differences are meaningful, and only
   * between frames from the same producer. `occurred_at` remains the wall
   * clock for display, storage and search.
   *
   * Optional: a producer that does not send one falls back to wall clock,
   * which is what the fence did before this existed.
   */
  capture_mono?: number;
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
