import { one, run } from "../db";
import { id, nowIso } from "../core/ids";
import type { Detection, DetectionFrame, Direction, Point, Severity, Zone } from "../core/types";
import { crossingOf, directionWanted, groundPoint, sideForZone } from "./geometry";
import { recordEvent } from "../l3/events";
import { zonesForCamera } from "../l3/zones";
import { cameraEnabled } from "../l3/cameras";

/**
 * L2 -- the virtual fence.
 *
 * Geometry over the video: a line or shape drawn on the camera's view, and a
 * judgement about who crossed it, which way, and whether that is worth waking
 * anybody up for.
 *
 * Three things separate this from the naive "line crossed: yes/no" version
 * that floods a control room by the third night:
 *
 *   1. Direction. Outbound and inbound are different events, so a farmer
 *      returning through a gate is not the same fact as someone approaching
 *      the fence from outside.
 *   2. Wait-and-confirm. A crossing must persist before a critical alarm
 *      fires, so a single frame's flicker is rejected rather than shouted.
 *      The delay is in SECONDS, not frames -- counted in frames, the same
 *      setting would silently mean four times longer on a slower machine.
 *   3. Class routing. Cattle, dogs and nilgai cross the fence constantly.
 *      They are written to the log and never alerted on.
 */

/** Per-track, per-zone memory. Lives in RAM; it is worthless after a restart. */
interface ZoneMemory {
  side: 1 | -1 | 0;
  pending?: {
    direction: Direction;
    sideAfter: 1 | -1 | 0;
    since: number;
    at: Point;
  };
}

interface TrackMemory {
  trackedThingId: string;
  class: string;
  cameraId: string;
  last: Point;
  lastSeen: number;
  path: Array<[number, number, number]>;
  zones: Map<string, ZoneMemory>;
}

const tracks = new Map<string, TrackMemory>();

/** A track not seen for this long is forgotten, and any pending crossing with it. */
const TRACK_IDLE_SECONDS = 30;
/** How much of the walked path is kept for the "why did this fire" overlay. */
const PATH_LIMIT = 60;

const trackKey = (cameraId: string, trackRef: string) => `${cameraId}/${trackRef}`;

// ------------------------------------------------------------------ zone loading

/**
 * A zone edit must not leave a track mid-crossing against the old shape --
 * the pending crossing would confirm against geometry that no longer exists.
 * Called by the zone routes after any change.
 */
export function forgetZone(zoneId: string): void {
  for (const track of tracks.values()) track.zones.delete(zoneId);
}

// ------------------------------------------------------------------ track memory

interface CameraContext {
  siteId: string;
  orgId: string;
  cameraName: string;
}

function cameraContext(cameraId: string): CameraContext | null {
  return one<CameraContext>(
    `SELECT s.id AS siteId, s.org_id AS orgId, c.name AS cameraName
       FROM camera c JOIN site s ON s.id = c.site_id
      WHERE c.id = $id`,
    { $id: cameraId },
  );
}

function upsertTrack(
  frame: DetectionFrame,
  detection: Detection,
  context: CameraContext,
  point: Point,
  at: number,
): TrackMemory {
  const key = trackKey(frame.camera_id, detection.track_ref);
  const existing = tracks.get(key);

  if (existing) {
    existing.lastSeen = at;
    existing.path.push([point[0], point[1], at]);
    if (existing.path.length > PATH_LIMIT) existing.path.shift();
    run(
      "UPDATE tracked_thing SET last_seen = $seen, path = $path WHERE id = $id",
      { $seen: frame.occurred_at, $path: JSON.stringify(existing.path), $id: existing.trackedThingId },
    );
    return existing;
  }

  // A track with a beginning and an end -- not a person with a history.
  const row = one<{ id: string }>(
    "SELECT id FROM tracked_thing WHERE camera_id = $camera AND track_ref = $ref",
    { $camera: frame.camera_id, $ref: detection.track_ref },
  );

  const trackedThingId = row?.id ?? id("trk");
  if (!row) {
    run(
      `INSERT INTO tracked_thing (id, org_id, camera_id, track_ref, class, first_seen, last_seen, path)
       VALUES ($id, $org, $camera, $ref, $class, $seen, $seen, $path)`,
      {
        $id: trackedThingId,
        $org: context.orgId,
        $camera: frame.camera_id,
        $ref: detection.track_ref,
        $class: detection.class,
        $seen: frame.occurred_at,
        $path: JSON.stringify([[point[0], point[1], at]]),
      },
    );
  }

  const fresh: TrackMemory = {
    trackedThingId,
    class: detection.class,
    cameraId: frame.camera_id,
    last: point,
    lastSeen: at,
    path: [[point[0], point[1], at]],
    zones: new Map(),
  };
  tracks.set(key, fresh);
  return fresh;
}

// ------------------------------------------------------------------ judgement

type Routing =
  | { kind: "alert"; severity: Severity }
  | { kind: "log_only"; reason: string }
  | { kind: "ignore" };

/**
 * What this class means here, according to the zone's ordered targets.
 *
 * The first target matching the class wins, and the list is already sorted by
 * priority -- so when a supervisor drags "person" above "vehicle", that order
 * is what decides. A class no target names produces nothing at all.
 */
function routeClass(zone: Zone, className: string): Routing {
  const target = zone.targets.find((t) => t.class === className);
  if (!target) return { kind: "ignore" };
  if (target.action === "log_only") {
    return { kind: "log_only", reason: "target_is_log_only" };
  }
  return { kind: "alert", severity: target.severity };
}

interface EmitArgs {
  zone: Zone;
  track: TrackMemory;
  context: CameraContext;
  frame: DetectionFrame;
  detection: Detection;
  direction: Direction;
  rule: string;
  routing: Routing;
  crossedAt: Point;
  heldSeconds: number;
}

/**
 * Every alert carries the reason it fired: the zone, the named rule, the
 * direction, the path walked and the confidence. An alert nobody can explain
 * is an alert that gets ignored.
 */
function emitCrossing(args: EmitArgs) {
  const { zone, track, context, frame, detection, routing } = args;

  const alertable = routing.kind === "alert";
  const severity: Severity = routing.kind === "alert" ? routing.severity : "INFO";
  const suppressedReason = routing.kind === "log_only" ? routing.reason : null;

  const subject = alertable ? detection.class : `${detection.class} (logged only)`;
  const title = `${subject} ${args.direction} at ${zone.name} · ${context.cameraName}`;

  return recordEvent({
    orgId: zone.org_id,
    siteId: context.siteId,
    kind: "zone_crossing",
    sourceType: "camera",
    sourceId: frame.source_id,
    simulated: frame.simulated,
    cameraId: frame.camera_id,
    zoneId: zone.id,
    trackedThingId: track.trackedThingId,
    class: detection.class,
    direction: args.direction,
    rule: args.rule,
    confidence: detection.confidence,
    severity,
    alertable,
    suppressedReason,
    occurredAt: frame.occurred_at,
    // The evidence bundle the screen draws its overlay from. Cheap to store,
    // and it is what makes the alert explainable at 3 a.m.
    evidence: {
      zone: { id: zone.id, name: zone.name, kind: zone.kind, geometry: zone.geometry, points: zone.points },
      crossedAt: args.crossedAt,
      path: track.path.map(([x, y]) => [x, y]),
      bbox: detection.bbox,
      trackRef: detection.track_ref,
      confirmSeconds: zone.confirm_seconds,
      heldSeconds: Number(args.heldSeconds.toFixed(2)),
      camera: context.cameraName,
    },
    // Same zone, same camera: related crossings become one piece of work.
    groupKey: `${frame.camera_id}:${zone.id}`,
    title,
  });
}

/**
 * Run one zone against one track's movement.
 *
 * Called once per detection per zone. Holds the wait-and-confirm state
 * machine: a crossing is noticed, held, and then either confirmed (the
 * subject stayed on the far side) or rejected as flicker (it came straight
 * back). Both outcomes are written down; only the first can raise an alarm.
 */
function evaluateZone(
  zone: Zone,
  track: TrackMemory,
  context: CameraContext,
  frame: DetectionFrame,
  detection: Detection,
  from: Point,
  to: Point,
  at: number,
) {
  const routing = routeClass(zone, detection.class);
  if (routing.kind === "ignore") return;

  let memory = track.zones.get(zone.id);
  if (!memory) {
    // First sighting against this zone: learn which side it starts on, and
    // deliberately do not treat that as a crossing.
    track.zones.set(zone.id, { side: sideForZone(zone, to) });
    return;
  }

  const currentSide = sideForZone(zone, to);

  // --- an unresolved crossing is waiting to be confirmed
  if (memory.pending) {
    const held = at - memory.pending.since;

    if (currentSide !== memory.pending.sideAfter) {
      // Came straight back. This is the flicker that floods control rooms.
      emitCrossing({
        zone, track, context, frame, detection,
        direction: memory.pending.direction,
        rule: "zone.crossing.flicker_rejected",
        routing: { kind: "log_only", reason: "did_not_persist" },
        crossedAt: memory.pending.at,
        heldSeconds: held,
      });
      memory.pending = undefined;
      memory.side = currentSide;
      return;
    }

    if (held >= zone.confirm_seconds) {
      emitCrossing({
        zone, track, context, frame, detection,
        direction: memory.pending.direction,
        rule: "zone.crossing.confirmed",
        routing,
        crossedAt: memory.pending.at,
        heldSeconds: held,
      });
      memory.pending = undefined;
      memory.side = currentSide;
      return;
    }

    // Still holding. Nothing is emitted yet, on purpose.
    memory.side = currentSide;
    return;
  }

  // --- no pending crossing: did this move cross the zone?
  const direction = crossingOf(zone, from, to);
  memory.side = currentSide;
  if (!direction || !directionWanted(zone, direction)) return;

  if (zone.confirm_seconds <= 0) {
    emitCrossing({
      zone, track, context, frame, detection,
      direction,
      rule: "zone.crossing.confirmed",
      routing,
      crossedAt: to,
      heldSeconds: 0,
    });
    return;
  }

  memory.pending = { direction, sideAfter: currentSide, since: at, at: to };
}

// ------------------------------------------------------------------ entry point

export interface FrameResult {
  cameraId: string;
  tracked: number;
  zonesEvaluated: number;
  /** Set when the frame was accepted but deliberately not judged. */
  skipped?: string;
}

/**
 * The only way a detection enters the system. Called by the ingress hook, so
 * a real detector and the simulator take exactly the same path.
 */
export function processFrame(frame: DetectionFrame): FrameResult {
  const context = cameraContext(frame.camera_id);
  if (!context) throw new Error(`unknown camera ${frame.camera_id}`);

  // Somebody took this feed out of service. Detections still arrive -- the
  // detector does not know -- but nothing is judged and no event is written,
  // because an operator was told this camera is not being watched.
  if (!cameraEnabled(frame.camera_id)) {
    return { cameraId: frame.camera_id, tracked: 0, zonesEvaluated: 0, skipped: "camera_disabled" };
  }

  const zones = zonesForCamera(frame.camera_id);
  const at = Date.parse(frame.occurred_at) / 1000;

  for (const detection of frame.detections) {
    const point = groundPoint(detection.bbox);
    const existing = tracks.get(trackKey(frame.camera_id, detection.track_ref));
    const from = existing?.last ?? point;

    const track = upsertTrack(frame, detection, context, point, at);

    for (const zone of zones) {
      evaluateZone(zone, track, context, frame, detection, from, point, at);
    }

    track.last = point;
  }

  sweepIdleTracks(at);
  return { cameraId: frame.camera_id, tracked: frame.detections.length, zonesEvaluated: zones.length };
}

/**
 * Forget tracks that have gone quiet. A crossing still pending when its track
 * disappears is recorded as unconfirmed rather than dropped silently -- it is
 * exactly the case a second look should catch.
 */
function sweepIdleTracks(now: number): void {
  for (const [key, track] of tracks) {
    if (now - track.lastSeen < TRACK_IDLE_SECONDS) continue;

    for (const [zoneId, memory] of track.zones) {
      if (!memory.pending) continue;
      const zone = one<{ id: string; org_id: string; name: string }>(
        "SELECT id, org_id, name FROM zone WHERE id = $id",
        { $id: zoneId },
      );
      if (!zone) continue;
      const context = cameraContext(track.cameraId);
      if (!context) continue;

      recordEvent({
        orgId: zone.org_id,
        siteId: context.siteId,
        kind: "zone_crossing",
        sourceType: "camera",
        sourceId: track.cameraId,
        simulated: true,
        cameraId: track.cameraId,
        zoneId,
        trackedThingId: track.trackedThingId,
        class: track.class,
        direction: memory.pending.direction,
        rule: "zone.crossing.unconfirmed_track_lost",
        confidence: null,
        severity: "INFO",
        alertable: false,
        suppressedReason: "track_lost_before_confirmation",
        occurredAt: nowIso(),
        evidence: {
          zone: { id: zone.id, name: zone.name },
          crossedAt: memory.pending.at,
          path: track.path.map(([x, y]) => [x, y]),
          heldSeconds: Number((now - memory.pending.since).toFixed(2)),
        },
        groupKey: `${track.cameraId}:${zoneId}`,
        title: `unconfirmed ${memory.pending.direction} crossing at ${zone.name}`,
      });
    }

    tracks.delete(key);
  }
}

/** Exposed for the status board and for tests. */
export const liveTrackCount = (): number => tracks.size;

export function resetFenceMemory(): void {
  tracks.clear();
}
