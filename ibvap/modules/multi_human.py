"""
Multi-human follow-up: who is in frame, where they have been, and whether we
have seen them before.

TWO LEVELS OF STATE, AND THE DIFFERENCE MATTERS:

  track      a ByteTrack id (`track_ref`). Cheap, free, and short-lived by
             construction -- it ends the moment ByteTrack's own association
             fails, whether that is because the subject truly left, or just
             walked behind a van for six seconds.

  identity   a `multi_human` PERSON id ("P1", "P2", ...), owned entirely by
             this module. One identity can span SEVERAL tracks over a run: a
             track dies, the identity does not, and when a later track's
             appearance matches an identity recently active, that later track
             is folded into the same identity instead of minting a new one.
             The identity's movement trail is what accumulates across that
             whole span -- one continuous line, not one per track.

THREE LAYERS, BUILT IN THIS ORDER ON PURPOSE:

  1. Within-camera tracking (ByteTrack, free). The baseline; always on.
  2. Short-occlusion recovery, ALSO free: `bytetrack.yaml`'s longer
     track_buffer lets ByteTrack itself re-associate a track across a few
     seconds of occlusion by motion alone, no appearance model involved. This
     is the cheapest fix for the common case and the first thing that fires.
  3. Appearance re-identification (`modules/reid.py`), for a gap longer than
     ByteTrack's buffer, or a subject who left the frame outright and
     re-entered. `HistogramReID` is a real, cheap, CPU-only colour signature
     -- see its own docstring for exactly what it can and cannot tell apart.
     With `reid: none` this layer produces nothing and every new track is a
     new identity; the naming rule at the bottom of reid.py still applies.

APPEARANCE ALONE IS NOT ENOUGH TO ACCEPT A MATCH, AND `_plausible()` IS WHY:
colour similarity says two crops look alike; it says nothing about whether the
identity being matched to could physically BE at this detection's position.
A person crossing the far side of frame a moment after someone in similar
clothing vanished near the camera is not a reappearance, no matter how well
the histograms line up -- it is a different person the colour signature
cannot tell apart, which is exactly HistogramReID's own documented weakness.
Every match this module accepts (`_resolve_pending`, `_check_swap`) is
therefore gated on the candidate identity's last known position: implied
speed (distance moved / time elapsed) must stay under `max_speed`, or the
candidate is skipped in favour of the next-best one, or no match at all.

A NEW TRACK IS "PENDING" FOR ITS FIRST `PENDING_FRAMES` DETECTIONS, NOT
RESOLVED ON THE FIRST ONE: a single poor crop -- motion blur, entry at the
frame edge, a half-visible body -- should not be the only chance a real match
gets. The module keeps trying every one of those frames and only commits to a
brand new identity once the window closes with nothing found. A pending track
still draws (its box is real, right now), it just has no `person_id` yet.

WHY TWO DIFFERENT PEOPLE CAN NEVER SHARE AN IDENTITY, BY CONSTRUCTION: every
identity resolved earlier in the SAME frame is excluded from that frame's
remaining matches (`claimed_this_frame`). Without this, two people in
similar-coloured clothing on screen at once could both match the same
identity in the gallery -- a worse failure than missing a real match, and one
that showed up in testing before this exclusion existed.

WHAT IS LIVE AND WHAT IS DURABLE:
  live     every person track, folded into its identity once confirmed, with
           that identity's FULL trail (see `trail_limit`) and its stable
           "P<n>" label. Continuous, useless five seconds later, never stored.
  durable  a confirmed re-identification -- this track has been folded into an
           identity seen before -- and nothing else. An ongoing trajectory is
           not an event; writing one down every frame would bury the record in
           noise and bloat a database that has to live at a post with no
           uplink.

WHY DWELL/LOITERING IS NOT HERE: it is a rule over this module's output, not a
different way of detecting people. It belongs in a new module reading the same
shared pass -- which is the case this plug-in layer exists to make cheap.

NOT BUILT HERE, ON PURPOSE: a searchable per-identity history ("show me every
appearance of P1, on every camera, with times"). That is a durable-side
feature -- it reads the `reidentification` events this module already emits
to the node, plus every `tracked_thing` row keyed by `track_ref` -- and
belongs in the edge node/console, not in a per-frame detector. This module's
job stops at handing the node a correct, stable `person_id` to key that
history on; building the history view itself is a separate, later piece of
work.

STATUS: prototype. Within-camera tracking and short-occlusion recovery are
solid; HistogramReID is real but weak -- see its docstring before trusting it
across similar-coloured clothing or a lighting change.
"""

from typing import Any

from core.payload import live_track
from modules.base import FrameContext, VisionModule, register
from modules.reid import Gallery, build_reid

TRACK_IDLE_SECONDS = 30.0
# Retries per new track before minting an identity instead of folding one in.
# 5, not 3: a track that starts right as its subject brushes past an
# occluder (a pole, another person) can have its first several crops
# corrupted, and the gallery's own multi-sample matching (reid.py) already
# absorbs most of the false-negative risk a longer window would otherwise add.
PENDING_FRAMES = 5
# Consecutive failed _check_swap comparisons (own identity AND every known
# candidate, both rejected) before minting a brand new identity for an
# ALREADY-RESOLVED track. Confirms a real appearance change (a hijack by an
# unseen person) rather than reacting to one noisy frame.
MISMATCH_STREAK_CONFIRM = 2


@register
class MultiHumanModule(VisionModule):
    name = "multi_human"

    def configure(self, params: dict[str, Any]) -> None:
        super().configure(params)
        # How often an ACTIVE track's appearance is refreshed and re-verified
        # against its own identity (_check_swap). Lower than it looks
        # expensive: HistogramReID is a resize and one cv2.calcHist call, so
        # checking every 2 processed frames instead of every 5 is still cheap
        # -- and it is directly what shortens how long a swap near a crossing
        # can show the wrong label before self-correcting.
        self.embed_every = max(1, int(params.get("embed_every", 2)))
        # 0 = unlimited, i.e. the whole run's path as one continuous line, per
        # claude.md's own §11 tuning note: fine for a bounded demo clip, set a
        # finite value for a long-running live source so memory stays bounded.
        self.trail_limit = int(params.get("trail_limit", 0))
        # Normalised frame-widths per second. NOT calibrated to real metres --
        # this camera's field of view is unknown here, so it is a deliberately
        # generous physical-plausibility gate (can a person really have
        # covered this much of the frame in this much time), not a measured
        # speed limit. Raised from an initial guess of 0.5 after it rejected a
        # genuine reappearance following a fraction-of-a-second occlusion --
        # that failure mode (a false rejection re-fragmenting a real person)
        # is worse than the one this gate exists to prevent (an implausible
        # match slipping through), so err generous until real numbers from
        # `_implied_speed`'s own logging justify tightening it again.
        self.max_speed = float(params.get("max_speed", 1.5))

        provider = params.get("reid", "histogram")

        if not hasattr(self, "_tracks"):
            # track_ref -> {identity, pending_trail, last_seen, embedded_at}
            # `identity` is None while pending.
            self._tracks: dict[str, dict] = {}
            # "P<n>" -> {trail, first_seen, last_seen}
            self._identities: dict[str, dict] = {}
            self._next_id = 1
            self.reidentified = 0
            self._provider_name = None

        if provider != self._provider_name:
            self.reid = build_reid(provider)
            self._provider_name = provider
            self.gallery = Gallery(
                # Not measured yet (claude.md §7) -- lowered from Gallery's
                # 0.75 default after real-clip near-misses clustered at
                # 0.6-0.75 for what looked like genuine reappearances. Safer
                # to move than it would have been before the same-frame
                # exclusion (above) existed: the worst failure mode a lower
                # threshold enables -- merging two DIFFERENT people -- can now
                # only happen when they are never in frame at the same time,
                # not the silent both-labelled-P1 failure that motivated the
                # exclusion fix.
                threshold=float(params.get("reid_threshold", 0.65)),
                ttl_seconds=float(params.get("reid_ttl_seconds", 120.0)),
            )
        # Identities that outlive the gallery's memory of them can never be
        # matched back into anyway -- pruning on the same horizon keeps one
        # lifecycle instead of two clocks that can disagree.
        self.identity_idle_seconds = self.gallery.ttl

    def process(self, frame, detections: list[dict], ctx: FrameContext):
        live: list[dict] = []
        durable: list[dict] = []

        people = [d for d in detections if d.get("is_person") and d.get("track_ref")]
        seen_tracks = set()
        # Every identity already resolved to a DIFFERENT track this frame --
        # excluded from the rest of this frame's matches. See the module
        # docstring: this is what stops two people sharing a "P<n>". This is
        # the PROACTIVE half of that guarantee -- it stops most collisions
        # before they happen. `_settle_collisions` below is the REACTIVE half,
        # for whatever slips past it.
        claimed_this_frame: set[str] = set()
        resolved: list[dict] = []  # {ref, person, point, track}, this frame's people

        for person in people:
            ref = person["track_ref"]
            seen_tracks.add(ref)
            point = (round(person["ground"][0], 4), round(person["ground"][1], 4))

            track = self._tracks.get(ref)
            if track is None:
                track = {"identity": None, "identity_since": None, "pending_trail": [],
                         "pending_since": ctx.ts, "last_seen": ctx.ts, "embedded_at": 0,
                         "mismatch_streak": 0}
                self._tracks[ref] = track
            track["last_seen"] = ctx.ts

            # The embedding a match was decided on, if any -- remembered under
            # the final identity only AFTER collision settlement below, never
            # here. Remembering immediately let a claim that LOSES a same-
            # frame collision still leave its embedding behind in the winner's
            # gallery, repeated every time the losing side retried: the
            # identity's own gallery slowly filled with the WRONG person's
            # samples until the rightful track failed its own appearance
            # check. That was the actual cause of a long-held identity being
            # discarded in testing, not the collision rule itself.
            pending_embedding = None

            if track["identity"] is None:
                track["pending_trail"].append(point)
                identity_id, event, pending_embedding = self._resolve_pending(
                    frame, person, ctx, track, claimed_this_frame)
                if identity_id is not None:
                    track["identity"] = identity_id
                    track["identity_since"] = ctx.ts
                    identity = self._identities[identity_id]
                    identity["trail"].extend(track["pending_trail"])
                    identity["last_seen"] = ctx.ts
                    track["pending_trail"] = []
                    if event:
                        durable.append(event)
            else:
                # Periodically checked for a SWAP before trusting the label
                # further: ByteTrack is IoU/motion only, and when two people's
                # boxes overlap heavily -- passing close by each other -- the
                # association it makes on the way out of that overlap can
                # attach the SAME track_ref to the other physical person. This
                # module has no way to see that happen; what it CAN do is keep
                # checking that a track's current appearance still supports
                # the identity it was given, and correct it when it clearly
                # does not, rather than only ever checking once at track start.
                if (self._provider_name != "none"
                        and ctx.frame_index - track["embedded_at"] >= self.embed_every):
                    track["embedded_at"] = ctx.frame_index
                    embedding = self.reid.embed(frame, person["bbox_px"])
                    if embedding is not None:
                        old_identity = track["identity"]
                        track["identity"], pending_embedding = self._check_swap(
                            track, embedding, point, ctx, claimed_this_frame)
                        if track["identity"] != old_identity:
                            track["identity_since"] = ctx.ts

                if track["identity"] is not None:
                    identity = self._identities[track["identity"]]
                    identity["trail"].append(point)
                    identity["last_seen"] = ctx.ts

            if track["identity"] is not None:
                claimed_this_frame.add(track["identity"])
            resolved.append({"ref": ref, "person": person, "point": point, "track": track,
                             "embedding": pending_embedding})

        self._settle_collisions(resolved, ctx)

        # Deferred remember(): only for whichever track actually kept its
        # identity after collision settlement. A demoted loser's embedding is
        # simply dropped -- exactly the contamination fix the comment above
        # describes.
        for r in resolved:
            if r["embedding"] is not None and r["track"]["identity"] is not None:
                self.gallery.remember(r["track"]["identity"], r["embedding"], ctx.ts)

        for r in resolved:
            track, point = r["track"], r["point"]
            identity_id = track["identity"]
            if identity_id is not None:
                identity = self._identities[identity_id]
                if self.trail_limit and len(identity["trail"]) > self.trail_limit:
                    del identity["trail"][: len(identity["trail"]) - self.trail_limit]
                trail_out = identity["trail"]
                age = round(ctx.ts - identity["first_seen"], 1)
            else:
                trail_out = track["pending_trail"]
                age = 0.0

            live.append(live_track(r["person"], {
                "track_ref": r["ref"],
                # The stable label. None while pending -- a real box with no
                # confirmed identity yet, not a wrong one. Named `person_id`,
                # never `identity` bare, so a reader one file away from
                # reid.py's naming rule still sees what kind of claim this is.
                "person_id": identity_id,
                "ground": list(point),
                "trail": trail_out,
                "age_seconds": age,
            }))

        # Raw track bookkeeping expires quickly -- ByteTrack itself has
        # already given up on it by the time this fires (bytetrack.yaml's
        # track_buffer), so keeping it longer buys nothing.
        for ref in [r for r, t in self._tracks.items()
                    if r not in seen_tracks and ctx.ts - t["last_seen"] > TRACK_IDLE_SECONDS]:
            del self._tracks[ref]

        # Identities outlive their tracks on purpose: this is what lets a
        # subject who left the frame and comes back thirty seconds later fold
        # back into their own trail instead of starting a new one. Pruned on
        # the gallery's own TTL, since a match against this identity is
        # already impossible once the gallery has forgotten its embedding.
        for identity_id in [i for i, v in self._identities.items()
                            if ctx.ts - v["last_seen"] > self.identity_idle_seconds]:
            del self._identities[identity_id]

        return live, durable

    def _settle_collisions(self, resolved: list[dict], ctx: FrameContext) -> None:
        """
        The REACTIVE half of "two tracks can never share an identity" (the
        PROACTIVE half is `claimed_this_frame`, excluded from matching as it
        goes -- this is the backstop for whatever slips past that).

        WHICH TRACK KEEPS THE IDENTITY, AND WHY THIS IS NOT ARBITRARY: the one
        with the OLDER `identity_since` -- the track that has held it longer.
        An earlier version bounced whichever track happened to be processed
        SECOND in the frame's detection order, which has nothing to do with
        which claim is actually right. That bug was concrete and observed: a
        track holding an identity for many frames lost a same-frame collision
        to a brand-new claim purely on ordering, got reset to pending, found
        no match above threshold on retry, and was minted as an entirely NEW
        identity -- discarding a perfectly good, long-established one for no
        reason but where it sat in a list. Tenure is the one signal available
        here that actually distinguishes "the real owner" from "whatever just
        showed up this frame".
        """
        by_identity: dict[str, list[dict]] = {}
        for r in resolved:
            identity_id = r["track"]["identity"]
            if identity_id is not None:
                by_identity.setdefault(identity_id, []).append(r)

        for identity_id, claimants in by_identity.items():
            if len(claimants) < 2:
                continue
            claimants.sort(key=lambda r: r["track"]["identity_since"] or ctx.ts)
            keeper = claimants[0]
            for loser in claimants[1:]:
                track = loser["track"]
                print(f"[multi_human] {identity_id} claimed by both {keeper['ref']} "
                      f"(since {keeper['track']['identity_since']}) and {loser['ref']} "
                      f"(since {track['identity_since']}) -- {loser['ref']} has the "
                      f"weaker claim, demoting it back to pending")
                track["identity"] = None
                track["identity_since"] = None
                track["pending_trail"] = [loser["point"]]
                track["mismatch_streak"] = 0

    def _implied_speed(self, identity_id: str, point: tuple[float, float],
                       ts: float) -> float | None:
        """
        Normalised frame-widths per second `identity_id` would have had to
        move at to be at `point` now, given where it was last actually seen.
        None when there is nothing to compare against (should not happen --
        every identity is minted with a point).
        """
        identity = self._identities.get(identity_id)
        if identity is None or not identity["trail"]:
            return None
        last_x, last_y = identity["trail"][-1]
        elapsed = max(ts - identity["last_seen"], 0.05)
        distance = ((point[0] - last_x) ** 2 + (point[1] - last_y) ** 2) ** 0.5
        return distance / elapsed

    def _plausible(self, identity_id: str, point: tuple[float, float], ts: float) -> bool:
        """Could `identity_id` physically be at `point` right now?"""
        speed = self._implied_speed(identity_id, point, ts)
        return speed is None or speed <= self.max_speed

    def _mint_identity(self, ctx: FrameContext, first_seen: float,
                       embedding: list[float] | None) -> str:
        identity_id = f"P{self._next_id}"
        self._next_id += 1
        self._identities[identity_id] = {"trail": [], "first_seen": first_seen, "last_seen": ctx.ts}
        if embedding is not None:
            self.gallery.remember(identity_id, embedding, ctx.ts)
        return identity_id

    def _check_swap(self, track: dict, embedding: list[float],
                    point: tuple[float, float], ctx: FrameContext,
                    claimed_this_frame: set[str]) -> tuple[str, list[float] | None]:
        """
        Does this track's CURRENT appearance still support the identity it
        was already given?

        Returns (identity_id, embedding_to_remember). The embedding is NOT
        remembered here -- the caller defers that until after this frame's
        collision settlement decides whether this claim actually survives
        (see the long comment in `process()` on why remembering early let a
        losing claim contaminate the gallery it was ultimately rejected from).

        THE CASE THIS EXISTS FOR: B, never tracked before, walks in front of
        A. The shared pass keeps producing boxes in roughly A's screen
        position -- it is B's body occupying it now -- and ByteTrack's own
        IoU/motion association can attach A's track_ref to B's detections
        without ever registering a new track at all. Earlier versions of this
        check only ever relabelled to a DIFFERENT KNOWN identity, so when B
        had no identity yet to match into, the check correctly noticed A's
        old label no longer fit and then did nothing, leaving B stuck wearing
        A's id for the rest of the run. It must mint B a NEW identity instead
        -- exactly what would have happened had B's own track started
        cleanly, which is what actually occurred here.

        CONFIRMED OVER `MISMATCH_STREAK_CONFIRM` CONSECUTIVE CHECKS, NOT ONE:
        a single ambiguous frame -- motion blur, a hand crossing the crop --
        should not fragment a real, continuing person into a new identity. A
        genuine hijack keeps failing every check; a noisy frame does not.

        Relabelling to an existing identity (the crossing-paths case) still
        takes priority over minting: if some other identity now plausibly
        matches better, that is preferred over assuming a stranger.

        This does not retroactively fix the trail already written under the
        OLD identity between when the hijack happened and when this notices
        -- those points stay misattributed for that brief span. It only
        corrects the label going forward.
        """
        identity_id = track["identity"]
        own_score = self.gallery.score_against(identity_id, embedding, ctx.ts)
        if own_score >= self.gallery.threshold:
            track["mismatch_streak"] = 0
            return identity_id, embedding  # still this identity -- refresh, deferred

        for candidate_id, score in self.gallery.candidates(
                embedding, ctx.ts, exclude=claimed_this_frame | {identity_id}):
            if not self._plausible(candidate_id, point, ctx.ts):
                continue
            print(f"[multi_human] {identity_id} no longer matches its own recent "
                  f"appearance ({own_score:.3f}) but matches {candidate_id} ({score:.3f}) -- "
                  f"relabelling, likely a crossing with another tracked person")
            track["mismatch_streak"] = 0
            return candidate_id, embedding  # deferred

        track["mismatch_streak"] += 1
        if track["mismatch_streak"] < MISMATCH_STREAK_CONFIRM:
            # Nothing to remember here regardless: doing so would plant this
            # very mismatched embedding in the identity's own gallery, so the
            # NEXT check would compare against a sample that is itself the
            # mismatch and (falsely) pass. Leave the gallery exactly as it
            # was; the next check gets a clean read.
            return identity_id, None  # could still be noise; wait for the next check

        # _mint_identity remembers immediately -- safe unlike the two returns
        # above, because a freshly minted id cannot already be claimed by
        # anything else this frame, so it cannot lose a collision.
        new_id = self._mint_identity(ctx, ctx.ts, embedding)
        print(f"[multi_human] {identity_id} no longer matches its own recent "
              f"appearance ({own_score:.3f}) and nothing known fits either -- "
              f"minting {new_id}, likely someone else now occupies this track")
        track["mismatch_streak"] = 0
        return new_id, None

    def _resolve_pending(self, frame, person, ctx: FrameContext, track: dict,
                         claimed_this_frame: set[str]
                         ) -> tuple[str | None, dict | None, list[float] | None]:
        """
        One attempt at folding a pending track into an existing identity.

        Returns (identity_id, durable_event, embedding_to_remember) once
        resolved -- either matched (embedding deferred -- see `process()`'s
        comment on why remembering here directly let a losing claim
        contaminate a gallery it was later rejected from), or the pending
        window closed and a new identity was minted (already remembered
        internally by `_mint_identity`, safe because a freshly minted id
        cannot lose a same-frame collision). Returns (None, None, None)
        while still waiting, so the caller keeps the track pending and tries
        again next frame.
        """
        if self._provider_name != "none":
            embedding = self.reid.embed(frame, person["bbox_px"])
            point = track["pending_trail"][-1]
            if embedding is not None:
                rejected_implausible = None
                for identity_id, score in self.gallery.candidates(
                        embedding, ctx.ts, exclude=claimed_this_frame):
                    speed = self._implied_speed(identity_id, point, ctx.ts)
                    if speed is not None and speed > self.max_speed:
                        rejected_implausible = speed
                        continue
                    self.reidentified += 1
                    event = {
                        "event_type": "reidentification",
                        "track_id": person.get("track_id"),
                        "data": {
                            "track_ref": person["track_ref"],
                            "matched_track_ref": identity_id,
                            "similarity": round(score, 4),
                            "provider": self.reid.name,
                            "class": "person",
                            "confidence": round(float(person["confidence"]), 4),
                            "bbox": [round(v, 5) for v in person["bbox_xywh"]],
                        },
                    }
                    return identity_id, event, embedding

                # A near-miss is the calibration signal this threshold needs
                # (claude.md §7: measured, not guessed) -- printed only when
                # there was something to compare against.
                near = self.gallery.best_score(embedding, ctx.ts, exclude=claimed_this_frame)
                if near > 0:
                    note = (f" (best candidate rejected: implied speed {rejected_implausible:.2f} "
                            f"> max_speed {self.max_speed})") if rejected_implausible else ""
                    print(f"[multi_human] pending match, closest = {near:.3f} "
                          f"(threshold {self.gallery.threshold}){note}")

        if len(track["pending_trail"]) < PENDING_FRAMES:
            return None, None, None  # keep waiting for a better crop

        embedding = None
        if self._provider_name != "none":
            embedding = self.reid.embed(frame, person["bbox_px"])
        new_id = self._mint_identity(ctx, track["pending_since"], embedding)
        # Previously silent -- this is the exact moment a track gives up on
        # matching anything known and becomes a brand new identity. Printed
        # unconditionally so a run's log shows every mint, not just the ones
        # that happened to log a near-miss on the way.
        print(f"[multi_human] minted {new_id} for track_ref {person['track_ref']} "
              f"(pending {len(track['pending_trail'])} frames, no plausible match found)")
        return new_id, None, None

    def stats(self) -> dict:
        pending = sum(1 for t in self._tracks.values() if t["identity"] is None)
        return {
            "identities": len(self._identities),
            "active_tracks": len(self._tracks),
            "pending": pending,
            "reid_provider": self._provider_name,
            "reidentified": self.reidentified,
        }
