import { one, run } from "../db";
import { id, nowIso } from "../core/ids";
import type { CameraStatus, Severity, Zone } from "../core/types";
import { recordEvent, shapeEvent } from "../l3/events";
import { zonesForCamera } from "../l3/zones";
import { setCameraStatus } from "../l3/cameras";
import { processVehicleAndPlateDetection, recordVehicleTraffic } from "../l3/watchlist";
import { getPersonWatchlistEntry, recordPersonWatchlistMatch } from "../l3/person_watchlist";
import { BadRequest } from "./hooks";

/**
 * The durable ingress for the vision service.
 *
 * TWO DOORS, AND THEY ARE NOT THE SAME DOOR:
 *
 *   /hooks/ingress/detections   raw per-frame detections, judged HERE by the
 *                               fence (l2/fence.ts). The simulator posts this.
 *   /hooks/ingress/events       already-confirmed events, judged by the vision
 *                               service. This file.
 *
 * The vision service runs fence geometry itself now, because a crossing has to
 * be decided against the frame it happened in and at the rate frames arrive.
 * What it does NOT decide is what a crossing MEANS: severity, whether a human
 * is woken, and whether this is a person to alarm about or a cow to write down
 * follow the zone's targets, which a supervisor edits on the console and which
 * are audited here. So the wire carries a fact -- "person crossed zone_3
 * inbound, held 1.4s" -- and this file applies the policy.
 *
 * That division is deliberate and load-bearing. If the vision service also
 * chose severity, changing a zone from WARNING to CRITICAL would mean pushing
 * config to every worker laptop before the change took effect, and the audit
 * log would describe an edit that had not happened yet.
 */

export interface VisionEvent {
  cameraId: string;
  module: string;
  eventType: string;
  trackId: number | null;
  data: Record<string, any>;
  /** Producer-monotonic seconds. Only differences are meaningful. */
  timestamp: number | null;
  occurredAt: string;
  sourceId: string;
  simulated: boolean;
}

const KNOWN_EVENTS = new Set(["intrusion", "vehicle_detection", "plate_read", "camera_health", "reidentification", "watchlist_match"]);

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new BadRequest(`${field} is required`);
  return value.trim();
}

function bboxOf(value: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  if (value.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
    throw new BadRequest("bbox must be four finite numbers");
  }
  return value as [number, number, number, number];
}

export function parseVisionEvent(body: unknown): VisionEvent {
  if (!body || typeof body !== "object") throw new BadRequest("body must be an object");
  const raw = body as Record<string, any>;

  const eventType = requireString(raw.event_type, "event_type");
  if (!KNOWN_EVENTS.has(eventType)) {
    throw new BadRequest(
      `unknown event_type ${eventType}; expected one of ${[...KNOWN_EVENTS].join(", ")}`,
    );
  }

  if (raw.data !== undefined && (raw.data === null || typeof raw.data !== "object")) {
    throw new BadRequest("data must be an object");
  }

  // Rejected rather than coerced when malformed, for the same reason
  // capture_mono is on the detection frame: a NaN in a clock silently poisons
  // every duration computed from it, and a wrong duration is worse than none.
  let timestamp: number | null = null;
  if (raw.timestamp !== undefined && raw.timestamp !== null) {
    if (typeof raw.timestamp !== "number" || !Number.isFinite(raw.timestamp)) {
      throw new BadRequest("timestamp must be a finite number of seconds");
    }
    timestamp = raw.timestamp;
  }

  const occurredAt = typeof raw.occurred_at === "string" ? raw.occurred_at : nowIso();
  if (Number.isNaN(Date.parse(occurredAt))) throw new BadRequest("occurred_at is not a valid timestamp");

  const cameraId = requireString(raw.camera_id, "camera_id");

  return {
    cameraId,
    module: requireString(raw.module, "module"),
    eventType,
    trackId: typeof raw.track_id === "number" && Number.isFinite(raw.track_id) ? raw.track_id : null,
    data: (raw.data as Record<string, any>) ?? {},
    timestamp,
    occurredAt,
    sourceId: typeof raw.source_id === "string" ? raw.source_id : cameraId,
    // Flagged at the adapter, once, so it cannot be forgotten downstream. A
    // looping clip is not a camera and the record says so.
    simulated: raw.simulated === true,
  };
}

interface CameraContext {
  siteId: string;
  orgId: string;
  cameraName: string;
}

function cameraContext(cameraId: string): CameraContext {
  const context = one<CameraContext>(
    `SELECT s.id AS siteId, s.org_id AS orgId, c.name AS cameraName
       FROM camera c JOIN site s ON s.id = c.site_id
      WHERE c.id = $id`,
    { $id: cameraId },
  );
  // A camera the node has never heard of is a configuration mistake, not a
  // detection. Rejecting it loudly is what turns a typo in cameras.yml into an
  // error message instead of a worker that runs fine and produces nothing.
  if (!context) throw new BadRequest(`unknown camera ${cameraId}`);
  return context;
}

/**
 * A track with a beginning and an end -- not a person with a history.
 *
 * Keyed on (camera_id, track_ref) exactly as the detection path keys it, so a
 * vision service that switches between the two ingress doors does not create a
 * second row for the same subject. `track_ref` is run-scoped by the producer
 * for precisely this reason: ByteTrack restarts its integers from 1.
 */
function upsertTrackedThing(
  event: VisionEvent,
  context: CameraContext,
  className: string,
): string | null {
  const trackRef = typeof event.data.track_ref === "string" ? event.data.track_ref.trim() : "";
  if (!trackRef) return null;

  const existing = one<{ id: string }>(
    "SELECT id FROM tracked_thing WHERE camera_id = $camera AND track_ref = $ref",
    { $camera: event.cameraId, $ref: trackRef },
  );

  const path = Array.isArray(event.data.path) ? event.data.path : [];

  if (existing) {
    run("UPDATE tracked_thing SET last_seen = $seen, path = $path WHERE id = $id", {
      $seen: event.occurredAt,
      $path: JSON.stringify(path),
      $id: existing.id,
    });
    return existing.id;
  }

  const trackedThingId = id("trk");
  run(
    `INSERT INTO tracked_thing (id, org_id, camera_id, track_ref, class, first_seen, last_seen, path)
     VALUES ($id, $org, $camera, $ref, $class, $seen, $seen, $path)`,
    {
      $id: trackedThingId,
      $org: context.orgId,
      $camera: event.cameraId,
      $ref: trackRef,
      $class: className,
      $seen: event.occurredAt,
      $path: JSON.stringify(path),
    },
  );
  return trackedThingId;
}

type Routing =
  | { kind: "alert"; severity: Severity }
  | { kind: "log_only"; reason: string }
  | { kind: "ignore" };

/**
 * What this class means at this zone, according to its ordered targets.
 *
 * The first target matching the class wins, and the list is already sorted by
 * priority -- so when a supervisor drags "person" above "vehicle", that order
 * is what decides. Cattle, dogs and nilgai cross a border fence constantly;
 * `log_only` is how they are written down and never shouted about.
 */
function routeClass(zone: Zone, className: string): Routing {
  const target = zone.targets.find((t) => t.class === className);
  if (!target) return { kind: "ignore" };
  if (target.action === "log_only") return { kind: "log_only", reason: "target_is_log_only" };
  return { kind: "alert", severity: target.severity };
}

// ------------------------------------------------------------------ intrusion

function ingestIntrusion(event: VisionEvent, context: CameraContext) {
  const data = event.data;
  const className = typeof data.class === "string" ? data.class : "object";
  const direction = data.direction === "outbound" ? "outbound" : "inbound";
  const rule = typeof data.rule === "string" ? data.rule : "zone.crossing.confirmed";
  const confirmed = rule === "zone.crossing.confirmed";

  const zoneId = typeof data.zone_id === "string" ? data.zone_id : null;
  const zone = zoneId ? zonesForCamera(event.cameraId).find((z) => z.id === zoneId) ?? null : null;

  let routing: Routing;
  if (!zone) {
    // The zone was deleted or unbound between the vision service's last config
    // refresh and this POST. The crossing still happened, so it is recorded
    // against the camera rather than discarded -- but nothing is woken up for
    // geometry that no longer exists.
    routing = { kind: "log_only", reason: "zone_no_longer_bound" };
  } else {
    routing = routeClass(zone, className);
    if (routing.kind === "ignore") {
      // Same race, other direction: the targets changed and this class is no
      // longer named here. Written down, never alerted.
      routing = { kind: "log_only", reason: "class_not_targeted" };
    }
  }

  // A track lost mid-crossing is real evidence -- it is what somebody stepping
  // out of view exactly at the fence line looks like -- but it is not a
  // confirmed crossing and must never raise an alarm as if it were.
  const alertable = confirmed && routing.kind === "alert";
  const severity: Severity = routing.kind === "alert" ? routing.severity : "INFO";
  const suppressedReason = alertable
    ? null
    : routing.kind === "log_only"
      ? routing.reason
      : "track_lost_before_confirmation";

  const trackedThingId = upsertTrackedThing(event, context, className);
  const zoneName = zone?.name ?? (typeof data.zone_name === "string" ? data.zone_name : "a removed zone");
  const subject = alertable ? className : `${className} (logged only)`;

  return recordEvent({
    orgId: context.orgId,
    siteId: context.siteId,
    kind: "zone_crossing",
    sourceType: "camera",
    sourceId: event.sourceId,
    simulated: event.simulated,
    cameraId: event.cameraId,
    zoneId: zone?.id ?? null,
    trackedThingId,
    class: className,
    direction,
    rule,
    confidence: typeof data.confidence === "number" ? data.confidence : null,
    severity,
    alertable,
    suppressedReason,
    occurredAt: event.occurredAt,
    // The bundle the screen draws its "why did this fire" overlay from. Cheap
    // to store, and it is what makes the alert explainable at 3 a.m.
    evidence: {
      zone: zone
        ? { id: zone.id, name: zone.name, kind: zone.kind, geometry: zone.geometry, points: zone.points }
        : { id: zoneId, name: zoneName, points: data.points ?? [] },
      crossedAt: data.crossed_at ?? null,
      path: Array.isArray(data.path) ? data.path : [],
      bbox: bboxOf(data.bbox) ?? null,
      trackRef: data.track_ref ?? null,
      // Both halves of the debounce, recorded as measured. The vision service
      // confirms on frames AND seconds; quoting one without the other hides
      // which of the two actually held the crossing back.
      confirmSeconds: typeof data.confirm_seconds === "number" ? data.confirm_seconds : null,
      confirmFrames: typeof data.confirm_frames === "number" ? data.confirm_frames : null,
      heldSeconds: typeof data.held_seconds === "number" ? data.held_seconds : null,
      heldFrames: typeof data.held_frames === "number" ? data.held_frames : null,
      camera: context.cameraName,
      detector: event.module,
    },
    // Same zone, same camera: related crossings become one piece of work.
    groupKey: `${event.cameraId}:${zone?.id ?? zoneId ?? "unbound"}`,
    title: `${subject} ${direction} at ${zoneName} · ${context.cameraName}`,
  });
}

// ------------------------------------------------------------------ plate read

function ingestVehicleDetection(event: VisionEvent, context: CameraContext) {
  const trackRef = requireString(event.data.track_ref, "data.track_ref");
  return recordVehicleTraffic({
    orgId: context.orgId,
    cameraId: event.cameraId,
    // sourceId contains the Vision run id, and trackRef is stable for the
    // physical track. Retries therefore cannot count the vehicle twice.
    sourceKey: `${event.sourceId}:${event.cameraId}:${trackRef}`,
    vehicleType: typeof event.data.vehicle_type === "string"
      ? event.data.vehicle_type
      : "vehicle",
    occurredAt: event.occurredAt,
  });
}

// ------------------------------------------------------------------ plate read

function ingestPlateRead(event: VisionEvent, context: CameraContext) {
  const data = event.data;
  const plate = typeof data.plate === "string" ? data.plate.trim() : "";
  // Never invent a plate. A read that did not happen is not a blank read; the
  // vision service simply would not have sent this event.
  if (!plate) throw new BadRequest("plate_read requires data.plate");

  return processVehicleAndPlateDetection({
    orgId: context.orgId,
    cameraId: event.cameraId,
    plateNumber: plate,
    vehicleType: typeof data.vehicle_type === "string" ? data.vehicle_type : "vehicle",
    confidence: typeof data.confidence === "number" ? data.confidence : undefined,
    plateConfidence: typeof data.plate_confidence === "number" ? data.plate_confidence : undefined,
    bbox: bboxOf(data.bbox),
    plateBbox: bboxOf(data.plate_bbox),
    imageSnapshot: typeof data.image_snapshot === "string" ? data.image_snapshot : null,
    simulated: event.simulated,
    occurredAt: event.occurredAt,
  });
}

// ------------------------------------------------------------------ camera health

const CAMERA_STATUSES: CameraStatus[] = ["FULL", "DEGRADED", "MOTION_ONLY", "RECORD_ONLY", "DEAD"];

/**
 * The blindness ladder, written by the only process that can actually see it.
 *
 * `camera.status` is OBSERVED, not decided -- the schema says so. The vision
 * service is the thing holding the socket, so it is the thing that knows a feed
 * stopped. An operator taking a camera out of service is a different fact and
 * lives in `camera.enabled`; the two are kept apart so the status board can say
 * "we cannot see" and "we chose to stop looking" separately.
 */
function ingestCameraHealth(event: VisionEvent, context: CameraContext) {
  const status = event.data.status;
  if (typeof status !== "string" || !CAMERA_STATUSES.includes(status as CameraStatus)) {
    throw new BadRequest(`status must be one of ${CAMERA_STATUSES.join(", ")}`);
  }

  setCameraStatus(event.cameraId, status as CameraStatus);

  const dead = status === "DEAD";
  return recordEvent({
    orgId: context.orgId,
    siteId: context.siteId,
    kind: "camera_health",
    sourceType: "camera",
    sourceId: event.sourceId,
    simulated: event.simulated,
    cameraId: event.cameraId,
    zoneId: null,
    class: "camera",
    rule: `camera.status.${status.toLowerCase()}`,
    severity: dead ? "WARNING" : "INFO",
    // A camera going dark is worth a human's attention; a camera coming back
    // is worth a line in the log and nothing more.
    alertable: dead,
    suppressedReason: dead ? null : "camera_recovered",
    occurredAt: event.occurredAt,
    evidence: {
      status,
      previous: event.data.previous ?? null,
      reconnects: event.data.reconnects ?? null,
      detail: event.data.detail ?? null,
      camera: context.cameraName,
    },
    groupKey: `${event.cameraId}:health`,
    title: dead
      ? `${context.cameraName} stopped sending frames`
      : `${context.cameraName} is sending frames again`,
  });
}

// ------------------------------------------------------------------ re-identification

/**
 * A returning track matched to one seen earlier, by appearance.
 *
 * INFO and never alertable for now: the vision service ships with a no-op ReID
 * provider, so in practice nothing reaches here yet. When a real embedding
 * model lands, whether a match wakes anybody is a policy question to be decided
 * with measured false-match rates in hand -- not a default to inherit quietly.
 */
function ingestReidentification(event: VisionEvent, context: CameraContext) {
  const data = event.data;
  const trackedThingId = upsertTrackedThing(event, context, "person");

  return recordEvent({
    orgId: context.orgId,
    siteId: context.siteId,
    kind: "reidentification",
    sourceType: "camera",
    sourceId: event.sourceId,
    simulated: event.simulated,
    cameraId: event.cameraId,
    zoneId: null,
    trackedThingId,
    class: "person",
    rule: "track.reidentified",
    confidence: typeof data.similarity === "number" ? data.similarity : null,
    severity: "INFO",
    alertable: false,
    suppressedReason: "reid_is_informational",
    occurredAt: event.occurredAt,
    evidence: {
      trackRef: data.track_ref ?? null,
      matchedTrackRef: data.matched_track_ref ?? null,
      similarity: data.similarity ?? null,
      provider: data.provider ?? null,
      bbox: bboxOf(data.bbox) ?? null,
      camera: context.cameraName,
    },
    groupKey: `${event.cameraId}:reid`,
    title: `person seen again at ${context.cameraName}`,
  });
}

// ------------------------------------------------------------------ person watchlist

/**
 * A tracked person matched against the person watchlist, by face (preferred)
 * or clothing-colour appearance (fallback) -- see l3/person_watchlist.ts's
 * recordPersonWatchlistMatch for why only a face match is alertable.
 *
 * The vision service sends the watchlist id it matched (data.matched_id): it
 * already holds the full entry, pulled from GET /api/watchlist/people on its
 * own refresh timer (modules/watchlist_client.py), so this file only has to
 * look the id back up to confirm it is real and get the name for the title --
 * it never re-runs the comparison the vision service already did.
 */
function ingestWatchlistMatch(event: VisionEvent, context: CameraContext) {
  const matchedId = requireString(event.data.matched_id, "data.matched_id");
  const entry = getPersonWatchlistEntry(matchedId);
  if (!entry) throw new BadRequest(`unknown watchlist entry ${matchedId}`);

  const signal = event.data.signal === "appearance" ? "appearance" : "face";
  const score = typeof event.data.score === "number" ? event.data.score : 0;
  const bbox = bboxOf(event.data.bbox) ?? [0, 0, 0, 0];

  return recordPersonWatchlistMatch({
    orgId: context.orgId,
    siteId: context.siteId,
    cameraId: event.cameraId,
    cameraName: context.cameraName,
    entry,
    signal,
    score,
    trackRef: typeof event.data.track_ref === "string" ? event.data.track_ref : "",
    bbox,
    simulated: event.simulated,
    occurredAt: event.occurredAt,
  });
}

// ------------------------------------------------------------------ the door

export function ingestVisionEvent(event: VisionEvent) {
  const context = cameraContext(event.cameraId);

  switch (event.eventType) {
    case "intrusion":
      return { event: shapeEvent(ingestIntrusion(event, context)) };
    case "plate_read":
      return { plateDetection: ingestPlateRead(event, context) };
    case "vehicle_detection":
      return { vehicleTraffic: ingestVehicleDetection(event, context) };
    case "camera_health":
      return { event: shapeEvent(ingestCameraHealth(event, context)) };
    case "reidentification":
      return { event: shapeEvent(ingestReidentification(event, context)) };
    case "watchlist_match":
      return { event: shapeEvent(ingestWatchlistMatch(event, context)) };
    default:
      // parseVisionEvent already rejected anything else; this is here so that
      // adding an event type without handling it fails loudly rather than
      // returning 202 for something nobody stored.
      throw new BadRequest(`unhandled event_type ${event.eventType}`);
  }
}
