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

/** What a target does when it matches. */
export type TargetAction = "alert" | "log_only";

/**
 * One thing a place must be detected against.
 *
 * `priority` is the order somebody declared these matter in, 1 highest.
 * `log_only` is the animal case: written to the record, never raised.
 */
export interface ZoneTarget {
  class: string;
  severity: Severity;
  action: TargetAction;
  priority: number;
  /** Set when a camera-specific rule displaced the zone's own. */
  overridden?: boolean;
}

/**
 * A zone as one camera sees it.
 *
 * The zone itself spans cameras; the shape does not, because a polygon drawn
 * in one camera's frame means nothing in another's. So this is the resolved
 * pairing -- this camera's shape, and the targets after any override.
 */
export interface Zone {
  id: string;
  bindingId: string;
  cameraId: string;
  name: string;
  kind: ZoneKind;
  geometry: ZoneGeometry;
  points: Point[];
  direction: Direction | "both";
  confirmSeconds: number;
  targets: ZoneTarget[];
  /** Derived from `targets`; convenient for tooltips and the status board. */
  watchClasses: string[];
  logOnlyClasses: string[];
  severity: Severity;
  active: boolean;
}

/** One camera's membership of a zone, as the zone screen sees it. */
export interface ZoneCamera {
  bindingId: string;
  cameraId: string;
  cameraName: string;
  cameraStatus: CameraStatus;
  geometry: ZoneGeometry;
  points: Point[];
  direction: Direction | "both";
  confirmSeconds: number;
  /** False while the shape is still the placeholder handed out on joining. */
  placed: boolean;
  active: boolean;
  overrides: ZoneTarget[];
  effectiveTargets: ZoneTarget[];
}

/** The whole zone: a named place, its cameras, and what matters there. */
export interface MonitoringZone {
  id: string;
  siteId: string;
  name: string;
  kind: ZoneKind;
  sector: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  targets: ZoneTarget[];
  cameras: ZoneCamera[];
}

export interface Camera {
  id: string;
  name: string;
  status: CameraStatus;
  zones: Zone[];
  /**
   * This camera's path on the media hub. Identical to `id` on purpose: whether
   * the path is fed by a looping clip or a camera on a wall is invisible from
   * here, so the console needs no notion of which it is watching.
   */
  streamPath?: string;
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

/**
 * Where live video and the live overlay come from.
 *
 * Addresses only. A real camera's RTSP URL carries credentials and stays on
 * the hub machine -- the console never sees one, and never needs to.
 */
export interface MediaConfig {
  /** Video: `${whepBase}/${streamPath}/whep`. WebRTC, hub straight to browser. */
  whepBase: string;
  /** Boxes: one socket, multiplexed by camera_id. Ephemeral, never stored. */
  boxesUrl: string;
}

export interface ServerConfig {
  org: Organisation;
  site: Site;
  users: AppUser[];
  cameras: Camera[];
  media?: MediaConfig;
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

/** Another camera watching the same zone as the one in hand. */
export interface CameraSibling {
  cameraId: string;
  cameraName: string;
  cameraStatus: CameraStatus;
  enabled: boolean;
  zoneId: string;
  zoneName: string;
}

/**
 * What else was watching, and what else it saw.
 *
 * Cameras on the zone are listed whether or not they caught anything, because
 * "the other camera saw nothing" is itself worth knowing.
 */
export interface CrossReference {
  zone: { id: string; name: string } | null;
  cameras: Array<{
    cameraId: string;
    cameraName: string;
    cameraStatus: CameraStatus;
    enabled: boolean;
    /** The camera this incident actually came from. */
    isSource: boolean;
  }>;
  incidents: Incident[];
  windowSeconds?: number;
}

export interface IncidentDetail {
  incident: Incident;
  events: IbvapEvent[];
  actions: Action[];
  crossReference: CrossReference;
}

/** A camera's own zone membership, with this camera's shape in each. */
export interface CameraZone {
  id: string;
  name: string;
  kind: ZoneKind;
  sector: string | null;
  geometry: ZoneGeometry;
  points: Point[];
  direction: Direction | "both";
  confirmSeconds: number;
  placed: boolean;
  targets: ZoneTarget[];
  /** Derived from `targets`, so a zone renders the same wherever it came from. */
  watchClasses: string[];
  logOnlyClasses: string[];
  severity: Severity;
}

/**
 * One camera, in full.
 *
 * `status` is observed by the analysis engine; `enabled` is decided by a
 * person. They are kept apart because "we cannot see" and "we stopped looking"
 * need different responses.
 */
export interface CameraDetail {
  id: string;
  siteId: string;
  name: string;
  /** Where the media hub serves this camera's video. */
  streamPath: string;
  streamUrl: string | null;
  status: CameraStatus;
  enabled: boolean;
  createdAt: string;
  updatedAt: string | null;
  zones: CameraZone[];
  siblings: CameraSibling[];
  incidents: { open: number; total: number };
}

export interface CameraIncidents {
  camera: CameraDetail;
  incidents: Incident[];
  recentEvents: IbvapEvent[];
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

// ---------------------------------------------------------------- Watchlist & ANPR (#36)

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
  image_snapshot?: string | null;
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

export interface CreateWatchlistInput {
  plateNumber: string;
  vehicleType?: string;
  makeModel?: string | null;
  color?: string | null;
  severity?: Severity;
  flagReason: string;
  notes?: string | null;
  active?: boolean;
}

export interface UpdateWatchlistInput {
  plateNumber?: string;
  vehicleType?: string;
  makeModel?: string | null;
  color?: string | null;
  severity?: Severity;
  flagReason?: string;
  notes?: string | null;
  active?: boolean;
  reason?: string;
}

export interface DetectVehicleInput {
  cameraId?: string;
  zoneId?: string | null;
  plateNumber?: string;
  vehicleType?: string;
  confidence?: number;
  plateConfidence?: number;
  bbox?: [number, number, number, number];
  plateBbox?: [number, number, number, number];
  imageSnapshot?: string | null;
  simulated?: boolean;
}

export interface FrameAnalysisResult {
  detections: PlateDetection[];
  totalInView: number;
}

// ---------------------------------------------------------------- media hub

/**
 * A camera as the media hub and the node jointly see it.
 *
 * `seeded` is the field that matters and the reason this is not just `Camera`:
 * a path can exist in the hub without a matching row in the node's database
 * (a typo in cameras.yml), or a row can exist with no feed arriving. Both are
 * real states with different fixes, and the console shows them apart rather
 * than quietly listing the intersection.
 */
export interface HubCamera {
  id: string;
  name: string;
  ready: boolean;
  readySince: string | null;
  readers: number;
  width: number | null;
  height: number | null;
  codec: string | null;
  whepUrl: string;
  seeded: boolean;
  status: CameraStatus | null;
  enabled: boolean | null;
}

export interface HubCameraList {
  hub: { url: string; reachable: boolean; error: string | null };
  cameras: HubCamera[];
}
