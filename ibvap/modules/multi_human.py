"""
Multi-human follow-up: who is in frame, where they have been, and — once a
ReID provider exists — whether we have seen them before.

TWO LAYERS, BUILT IN THIS ORDER ON PURPOSE:

  1. Within-camera tracking. Free: the shared pass already carries ByteTrack
     ids, so this layer costs one dictionary per camera. It streams live and
     is the baseline the demo actually runs on.

  2. Cross-camera / re-entry matching via appearance embeddings. Layered on
     top through `modules/reid.py`. With the default `none` provider this layer
     produces nothing at all — not a guess, not a maybe. That is the point:
     see the naming rule at the bottom of reid.py.

WHAT IS LIVE AND WHAT IS DURABLE:
  live     every person track, with its recent trajectory. Continuous, useless
           five seconds later, never stored.
  durable  a confirmed re-identification — this track is a subject seen
           before — and nothing else. An ongoing trajectory is not an event;
           writing one down every frame would bury the record in noise and
           bloat a database that has to live at a post with no uplink.

WHY DWELL/LOITERING IS NOT HERE: it is a rule over this module's output, not a
different way of detecting people. It belongs in a new module reading the same
shared pass — which is the case this plug-in layer exists to make cheap.

STATUS: prototype. Within-camera tracking works; re-ID is interface-only.
"""

from typing import Any

from core.payload import live_track
from modules.base import FrameContext, VisionModule, register
from modules.reid import Gallery, build_reid

TRAIL_LIMIT = 60
TRACK_IDLE_SECONDS = 30.0


@register
class MultiHumanModule(VisionModule):
    name = "multi_human"

    def configure(self, params: dict[str, Any]) -> None:
        super().configure(params)
        self.embed_every = max(1, int(params.get("embed_every", 10)))
        provider = params.get("reid", "none")

        if not hasattr(self, "_tracks"):
            self._tracks: dict[str, dict] = {}
            self.reidentified = 0
            self._provider_name = None

        if provider != self._provider_name:
            self.reid = build_reid(provider)
            self._provider_name = provider
            self.gallery = Gallery(
                threshold=float(params.get("reid_threshold", 0.75)),
                ttl_seconds=float(params.get("reid_ttl_seconds", 120.0)),
            )

    def process(self, frame, detections: list[dict], ctx: FrameContext):
        live: list[dict] = []
        durable: list[dict] = []

        people = [d for d in detections if d.get("is_person") and d.get("track_ref")]
        seen = set()

        for person in people:
            ref = person["track_ref"]
            seen.add(ref)
            point = person["ground"]

            track = self._tracks.get(ref)
            if track is None:
                track = {"trail": [], "first_seen": ctx.ts, "last_seen": ctx.ts,
                         "matched": None, "embedded_at": 0}
                self._tracks[ref] = track

            track["last_seen"] = ctx.ts
            track["trail"].append((round(point[0], 4), round(point[1], 4)))
            if len(track["trail"]) > TRAIL_LIMIT:
                del track["trail"][: len(track["trail"]) - TRAIL_LIMIT]

            event = self._maybe_match(frame, person, track, ctx)
            if event:
                durable.append(event)

            live.append(live_track(person, {
                "track_ref": ref,
                "ground": [round(point[0], 5), round(point[1], 5)],
                "trail": track["trail"][-20:],
                "age_seconds": round(ctx.ts - track["first_seen"], 1),
                # Named `matched_ref`, never `identity`: it says which earlier
                # TRACK this one resembles, not who anybody is.
                "matched_ref": track["matched"],
            }))

        for ref in [r for r, t in self._tracks.items()
                    if r not in seen and ctx.ts - t["last_seen"] > TRACK_IDLE_SECONDS]:
            del self._tracks[ref]

        return live, durable

    def _maybe_match(self, frame, person, track, ctx: FrameContext) -> dict | None:
        """
        Ask the provider for an embedding, and the gallery whether it has seen
        one like it. With the `none` provider this returns immediately and the
        module is pure within-camera tracking.
        """
        if track["matched"] is not None:
            return None
        if ctx.frame_index - track["embedded_at"] < self.embed_every:
            return None
        track["embedded_at"] = ctx.frame_index

        embedding = self.reid.embed(frame, person["bbox_px"])
        if embedding is None:
            return None

        ref = person["track_ref"]
        hit = self.gallery.match(embedding, ctx.ts)
        self.gallery.remember(ref, embedding, ctx.ts)
        if hit is None:
            return None

        matched_ref, score = hit
        if matched_ref == ref:
            return None
        track["matched"] = matched_ref
        self.reidentified += 1
        return {
            "event_type": "reidentification",
            "track_id": person.get("track_id"),
            "data": {
                "track_ref": ref,
                "matched_track_ref": matched_ref,
                "similarity": round(score, 4),
                "provider": self.reid.name,
                "class": "person",
                "confidence": round(float(person["confidence"]), 4),
                "bbox": [round(v, 5) for v in person["bbox_xywh"]],
            },
        }

    def stats(self) -> dict:
        return {
            "tracks": len(self._tracks),
            "reid_provider": self._provider_name,
            "reidentified": self.reidentified,
        }
