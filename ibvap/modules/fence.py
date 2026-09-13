"""
Virtual fence: zone intrusion and line crossing.

Geometry over the video — a line or a shape drawn on the camera's view, and a
judgement about who crossed it and which way.

Three things separate this from the naive "line crossed: yes/no" version that
floods a control room by the third night:

  1. Direction. Outbound and inbound are different facts, so a farmer returning
     through a gate is not the same event as someone approaching from outside.
  2. Wait-and-confirm. A crossing must persist before it becomes durable, so a
     single frame's flicker is rejected rather than shouted. Held BOTH in
     frames (the spec's debounce) and in seconds (the zone's own
     `confirm_seconds`, set by a supervisor) — see CONFIRM below.
  3. Class routing is NOT done here. This module reports that `person` crossed
     `zone_3` inbound; the node decides whether that is CRITICAL, a WARNING, or
     a cow to be written down and never mentioned. Severity lives with the
     operator-editable zone targets, and this process must stay ignorant of it.

CONFIRM — why two clocks, not one:
The spec asks for N consecutive confirming frames. A zone carries
`confirm_seconds`, set by a supervisor who thinks in seconds, not frames.
Counted in frames alone the same setting silently means four times longer on a
slower laptop; counted in seconds alone a stalled stream can "hold" a crossing
while showing one frozen image. So a crossing confirms only when it has
survived BOTH — N frames of evidence AND the supervisor's wall of time. At the
capped cadence in config.py, N frames is about N / target_fps seconds anyway.

COOLDOWN is per (track, zone, DIRECTION): one confirmed crossing per subject
per zone per direction per window. Without it a person loitering on a fence line
emits an event every time they shuffle across. Keyed by direction because
walking in and walking back out are two facts, and collapsing them would lose
the exit an investigator went looking for.

STATUS: prototype.
"""

import time
from typing import Any

from core import geometry
from core.payload import live_track
from modules.base import FrameContext, VisionModule, register

#: A track unseen for this long is forgotten, along with any pending crossing.
TRACK_IDLE_SECONDS = 30.0
#: How much of the walked path is kept, for the "why did this fire" overlay.
TRAIL_LIMIT = 60


class _ZoneMemory:
    __slots__ = ("side", "pending", "cooled_until")

    def __init__(self, side: int):
        self.side = side
        self.pending: dict | None = None
        # Cooldown is per DIRECTION, not just per (track, zone). A person who
        # walks in through a gate and back out ninety seconds later has done two
        # different things, and an exit suppressed as a duplicate of the entry
        # is exactly the record an investigator would need and not find.
        # Re-crossing the SAME way inside the window is the flapping this
        # suppresses.
        self.cooled_until: dict[str, float] = {}


class _TrackMemory:
    __slots__ = ("track_ref", "klass", "last", "last_seen", "trail", "zones")

    def __init__(self, track_ref: str, klass: str, point, ts: float):
        self.track_ref = track_ref
        self.klass = klass
        self.last = point
        self.last_seen = ts
        self.trail: list[tuple[float, float, float]] = [(point[0], point[1], ts)]
        self.zones: dict[str, _ZoneMemory] = {}


@register
class FenceModule(VisionModule):
    name = "fence"

    def configure(self, params: dict[str, Any]) -> None:
        super().configure(params)
        self.confirm_frames = max(1, int(params.get("confirm_frames", 3)))
        self.cooldown_seconds = float(params.get("cooldown_seconds", 20.0))

        zones = []
        for zone in params.get("zones") or []:
            points = [(float(p[0]), float(p[1])) for p in zone.get("points") or []]
            minimum = 3 if zone.get("geometry") == "polygon" else 2
            if len(points) < minimum:
                # A zone that cannot be evaluated is skipped loudly rather than
                # judged wrongly. Silently ignoring it would look identical to a
                # fence that simply never fires.
                print(f"[fence] {self.camera_id}: zone {zone.get('id')} has "
                      f"{len(points)} points, needs {minimum} - skipped")
                continue
            zones.append({
                "id": zone["id"],
                "name": zone.get("name", zone["id"]),
                "kind": zone.get("kind", "fence_line"),
                "geometry": zone.get("geometry", "line"),
                "points": points,
                "direction": zone.get("direction", "both"),
                "confirm_seconds": float(zone.get("confirm_seconds", 0.0)),
                "classes": set(zone.get("classes") or []),
            })
        self.zones = zones

        # A zone that changed shape must not leave a track mid-crossing against
        # geometry that no longer exists: the pending crossing would confirm
        # against a line the operator has already moved. Track positions stay;
        # only the per-zone judgement is reset.
        live_ids = {z["id"] for z in zones}
        for track in getattr(self, "_tracks", {}).values():
            for zone_id in list(track.zones):
                if zone_id not in live_ids:
                    del track.zones[zone_id]

        if not hasattr(self, "_tracks"):
            self._tracks: dict[str, _TrackMemory] = {}
            self.confirmed = 0
            self.rejected = 0
            self.lost = 0

    # ── the pass ─────────────────────────────────────────────────────────

    def process(self, frame, detections: list[dict], ctx: FrameContext):
        live: list[dict] = []
        durable: list[dict] = []

        if not self.zones:
            return live, durable

        seen: set[str] = set()

        for detection in detections:
            ref = detection.get("track_ref")
            if not ref:
                # The tracker has not issued an id yet. A crossing needs two
                # positions of the SAME subject, so an unconfirmed detection has
                # nothing to compare against and is not drawn as a fence track.
                continue

            relevant = [z for z in self.zones
                        if not z["classes"] or detection["class"] in z["classes"]]
            if not relevant:
                continue

            seen.add(ref)
            point = detection["ground"]
            track = self._tracks.get(ref)
            if track is None:
                track = _TrackMemory(ref, detection["class"], point, ctx.ts)
                self._tracks[ref] = track
                for zone in relevant:
                    track.zones[zone["id"]] = _ZoneMemory(
                        geometry.side_for_zone(zone["geometry"], zone["points"], point)
                    )
                live.append(live_track(detection, self._extra(track, [])))
                continue

            frm, to = track.last, point
            track.last = point
            track.last_seen = ctx.ts
            track.trail.append((point[0], point[1], ctx.ts))
            if len(track.trail) > TRAIL_LIMIT:
                del track.trail[: len(track.trail) - TRAIL_LIMIT]

            zone_states = []
            for zone in relevant:
                event = self._evaluate(zone, track, detection, frm, to, ctx)
                if event:
                    durable.append(event)
                memory = track.zones[zone["id"]]
                zone_states.append({
                    "zone_id": zone["id"],
                    "name": zone["name"],
                    "side": memory.side,
                    "pending": memory.pending is not None,
                    "held": round(ctx.ts - memory.pending["since"], 2) if memory.pending else 0.0,
                    "direction": memory.pending["direction"] if memory.pending else None,
                })

            live.append(live_track(detection, self._extra(track, zone_states)))

        durable.extend(self._evict(ctx, seen))
        return live, durable

    # ── the state machine ────────────────────────────────────────────────

    def _evaluate(self, zone, track, detection, frm, to, ctx) -> dict | None:
        memory = track.zones.get(zone["id"])
        if memory is None:
            memory = _ZoneMemory(geometry.side_for_zone(zone["geometry"], zone["points"], to))
            track.zones[zone["id"]] = memory
            return None

        side_now = geometry.side_for_zone(zone["geometry"], zone["points"], to)

        # --- a crossing is already being held, waiting to confirm
        if memory.pending:
            pending = memory.pending
            if side_now != pending["side_after"]:
                # Came straight back. Flicker, not a crossing. Rejected here and
                # never sent: the durable channel carries confirmed facts only,
                # and a control room that is told about every wobble stops
                # reading the ones that matter.
                memory.pending = None
                memory.side = side_now
                self.rejected += 1
                return None

            pending["frames"] += 1
            held = ctx.ts - pending["since"]
            if pending["frames"] >= self.confirm_frames and held >= zone["confirm_seconds"]:
                memory.pending = None
                memory.side = side_now
                if ctx.ts < memory.cooled_until.get(pending["direction"], 0.0):
                    return None
                memory.cooled_until[pending["direction"]] = ctx.ts + self.cooldown_seconds
                self.confirmed += 1
                return self._intrusion(
                    zone, track, detection, ctx,
                    direction=pending["direction"],
                    crossed_at=pending["at"],
                    held=held,
                    frames=pending["frames"],
                    rule="zone.crossing.confirmed",
                )
            return None

        # --- no crossing pending: did one just start?
        direction = geometry.crossing_of(zone["geometry"], zone["points"], frm, to)
        if direction is None:
            memory.side = side_now
            return None
        if not geometry.direction_wanted(zone["direction"], direction):
            # The zone is watching the other way. Recorded as a side change so
            # the next crossing is judged from the right place, and nothing else.
            memory.side = side_now
            return None

        # confirm_seconds == 0 and one frame of evidence means the supervisor
        # asked for no delay at all. Honour it rather than inventing a floor.
        if self.confirm_frames <= 1 and zone["confirm_seconds"] <= 0:
            memory.side = side_now
            if ctx.ts < memory.cooled_until.get(direction, 0.0):
                return None
            memory.cooled_until[direction] = ctx.ts + self.cooldown_seconds
            self.confirmed += 1
            return self._intrusion(
                zone, track, detection, ctx,
                direction=direction, crossed_at=to, held=0.0, frames=1,
                rule="zone.crossing.confirmed",
            )

        memory.pending = {
            "direction": direction,
            "side_after": side_now,
            "since": ctx.ts,
            "frames": 1,
            "at": to,
        }
        return None

    def _evict(self, ctx: FrameContext, seen: set[str]) -> list[dict]:
        """
        Forget idle tracks, and be honest about the ones lost mid-crossing.

        A subject that steps out of view exactly at the fence line is a real
        signal, not an absence of one — it is what someone avoiding a camera
        looks like. It goes to the node as its own event type so the record can
        hold it without it ever being mistaken for a confirmed crossing.
        """
        out: list[dict] = []
        for ref in list(self._tracks):
            track = self._tracks[ref]
            if ref in seen or (ctx.ts - track.last_seen) < TRACK_IDLE_SECONDS:
                continue
            for zone_id, memory in track.zones.items():
                if not memory.pending:
                    continue
                zone = next((z for z in self.zones if z["id"] == zone_id), None)
                if zone is None:
                    continue
                self.lost += 1
                out.append(self._intrusion(
                    zone, track, {"class": track.klass, "confidence": 0.0,
                                  "bbox_xywh": None, "track_id": None},
                    ctx,
                    direction=memory.pending["direction"],
                    crossed_at=memory.pending["at"],
                    held=track.last_seen - memory.pending["since"],
                    frames=memory.pending["frames"],
                    rule="zone.crossing.unconfirmed_track_lost",
                ))
            del self._tracks[ref]
        return out

    # ── payload builders ─────────────────────────────────────────────────

    def _extra(self, track: _TrackMemory, zone_states: list[dict]) -> dict:
        return {
            "track_ref": track.track_ref,
            "ground": [round(track.last[0], 5), round(track.last[1], 5)],
            "trail": [[round(x, 4), round(y, 4)] for x, y, _ in track.trail[-20:]],
            "zones": zone_states,
        }

    def _intrusion(self, zone, track, detection, ctx: FrameContext, *,
                   direction, crossed_at, held, frames, rule) -> dict:
        """
        The durable payload. Every field here answers a question an operator
        will ask at 3 a.m.: which zone, which way, how long was it held, what
        path did it walk, and how sure was the detector.
        """
        return {
            "event_type": "intrusion",
            "track_id": detection.get("track_id"),
            "data": {
                "track_ref": track.track_ref,
                "class": track.klass,
                "zone_id": zone["id"],
                "zone_name": zone["name"],
                "zone_kind": zone["kind"],
                "geometry": zone["geometry"],
                "points": [[round(x, 5), round(y, 5)] for x, y in zone["points"]],
                "direction": direction,
                "rule": rule,
                "confidence": round(float(detection.get("confidence") or 0.0), 4),
                "bbox": detection.get("bbox_xywh"),
                "crossed_at": [round(crossed_at[0], 5), round(crossed_at[1], 5)],
                "path": [[round(x, 4), round(y, 4)] for x, y, _ in track.trail],
                "confirm_seconds": zone["confirm_seconds"],
                "confirm_frames": self.confirm_frames,
                "held_seconds": round(held, 2),
                "held_frames": frames,
            },
        }

    def stats(self) -> dict:
        return {
            "zones": len(self.zones),
            "tracks": len(self._tracks),
            "confirmed": self.confirmed,
            "rejected_flicker": self.rejected,
            "lost_mid_crossing": self.lost,
        }
