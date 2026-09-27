"""
The seconds either side of a crossing, kept as frames.

STATUS: prototype

WHAT THIS IS, AND WHAT IT IS NOT. This is not video recording. It is a short
sequence of the frames the DETECTOR ACTUALLY JUDGED, at the cadence it judged
them (`IBVAP_TARGET_FPS`, ~6/s), with the boxes it saw on each one. That
distinction is the whole argument for the feature: a video clip shows what a
camera pointed at, while this shows what the decision was made from. When a
jury or an investigator asks "what did the system see when it fired", these are
literally the frames, not a reconstruction of them.

It also means nobody should dress the result up as 30 fps footage. The console
labels it with its real rate.

DOES THIS CONTRADICT SECTION 8? No, and the distinction is worth stating because
it looks like it does. Section 8 commits to "only events and thumbnails sync
UPSTREAM, never video" -- that is about what crosses a BOP's uplink to higher
command, where bandwidth is the constraint the whole thesis rests on. A clip
stored on the node and served to the console on the same LAN crosses no uplink.
Nothing here changes what syncs upward.

WHY THE RING HOLDS RAW FRAMES AND ENCODES ONLY ON TRIGGER. The obvious design
is to JPEG every frame as it arrives, so the ring is small. But crossings are
seconds to minutes apart while frames are relentless, so that pays an encode on
every frame to serve the rare one:

    encode always     6 fps x ~3 ms  = ~1.8 % of a core, continuously, per camera
    encode on trigger  36 frames x ~3 ms = ~0.36 % of a core at one crossing / 30 s

Five times cheaper on the only budget that matters (section 3), traded for RAM
that is bounded and knowable: `frames x width x height x 3` bytes, reported by
`stats()` so it is never a mystery. Frames are downscaled on the way in when
they are wider than `max_width`, which is what keeps a 1080p camera from turning
a 29 MB ring into a 150 MB one.

NONE OF THESE NUMBERS ARE MEASURED. They are arithmetic from a ~3 ms encode
estimate. Per section 7 they stay out of any slide until `main.py --seconds 60`
has been run on the machine in question, with and without clips enabled.

THE POST-ROLL PROBLEM, and why the event does not wait for it. A crossing is
confirmed at time T, but the interesting part continues for a few seconds after
-- which way it went, whether it came back. So a clip is not complete until
T + post_seconds. The intrusion event must NOT wait that long: an operator being
told about a fence crossing four seconds late is four seconds of a person
walking. So the event goes immediately carrying a `clip_id`, and the clip
follows under that id when it is ready. The console shows the incident at once
and the frames when they land.

`clip_id` is minted HERE rather than taken from the node's event id, so the
link exists at the moment the event is emitted and does not depend on reading an
HTTP response or on the node having answered at all.
"""

import time
from collections import deque
from typing import Any, Optional

import cv2

#: Frames wider than this are downscaled on the way into the ring. 720 keeps a
#: person recognisable at the far end of a fence line while capping a 1080p
#: camera's ring at about a third of what it would otherwise hold.
DEFAULT_MAX_WIDTH = 720

#: Matches core/thumbnail.py. Below about 60 the blocking artefacts start to
#: look like detections, which on an evidence frame is worse than a larger file.
DEFAULT_QUALITY = 70

#: A clip that never completed -- the process is shutting down, or post-roll
#: frames stopped arriving because the camera did. Collected anyway rather than
#: dropped: a truncated clip of a crossing is evidence, and its absence is not.
MAX_PENDING_AGE_SECONDS = 30.0


class _Pending:
    """One clip being collected: its pre-roll, and the post-roll still coming."""

    __slots__ = ("clip_id", "at", "until", "frames", "opened")

    def __init__(self, clip_id: str, at: float, until: float, frames: list):
        self.clip_id = clip_id
        self.at = at
        self.until = until
        # A COPY of the ring at trigger time. Sharing it would let later frames
        # push the crossing itself out of the pre-roll while the clip is still
        # being collected -- the one frame the clip exists for.
        self.frames = frames
        self.opened = time.time()


class ClipRecorder:
    """
    A ring of recent frames for one camera, and the clips cut from it.

    Deliberately knows nothing about zones, crossings or events. It is handed
    frames and told "start one now"; what counts as worth recording is the
    fence module's judgement, not this file's.
    """

    def __init__(
        self,
        pre_seconds: float = 4.0,
        post_seconds: float = 2.0,
        fps_hint: float = 6.0,
        max_width: int = DEFAULT_MAX_WIDTH,
        quality: int = DEFAULT_QUALITY,
    ):
        self.pre_seconds = max(0.0, float(pre_seconds))
        self.post_seconds = max(0.0, float(post_seconds))
        self.max_width = int(max_width)
        self.quality = int(quality)

        # Sized from the cadence rather than from seconds alone, plus a margin:
        # a worker running below its target rate would otherwise hold less
        # history than the operator was promised, silently.
        depth = int(self.pre_seconds * max(1.0, float(fps_hint))) + 2
        self._ring: deque = deque(maxlen=max(1, depth))
        self._pending: list[_Pending] = []

        self.cut = 0
        self.dropped_empty = 0
        self._counter = 0

    # ── the hot path ─────────────────────────────────────────────────────

    def add(self, ts: float, frame, boxes: Optional[list] = None) -> None:
        """
        Offer one processed frame. Called every frame; must stay cheap.

        The frame is COPIED. Modules receive the same array this does and
        nothing forbids one of them drawing on it, so keeping a reference would
        mean a clip whose contents depend on which modules ran afterwards --
        the kind of bug that only appears once another module is added.
        """
        if frame is None:
            return

        try:
            kept = frame
            height, width = frame.shape[:2]
            if width > self.max_width and width > 0:
                scale = self.max_width / float(width)
                kept = cv2.resize(
                    frame,
                    (self.max_width, max(1, int(round(height * scale)))),
                    interpolation=cv2.INTER_AREA,
                )
            else:
                kept = frame.copy()

            entry = (float(ts), kept, list(boxes or []))
            self._ring.append(entry)
            for pending in self._pending:
                pending.frames.append(entry)
        except Exception:  # noqa: BLE001
            # This runs inside the detection loop. A frame that cannot be
            # buffered must never be a frame that stops detection.
            return

    def start(self, clip_id: str, at: float) -> None:
        """
        Begin collecting a clip around `at`, using the ring as its pre-roll.

        Idempotent per id: the fence module may confirm two crossings on the
        same camera in the same frame (two zones), and each asks for its own
        clip. Two clips with one id would overwrite each other on the node.
        """
        if any(pending.clip_id == clip_id for pending in self._pending):
            return
        self._pending.append(
            _Pending(clip_id, at, at + self.post_seconds, list(self._ring))
        )

    def next_id(self, run_id: str, camera_id: str) -> str:
        self._counter += 1
        return f"clip_{run_id}_{camera_id}_{self._counter}"

    # ── collection ───────────────────────────────────────────────────────

    def collect(self, now: Optional[float] = None, *, force: bool = False) -> list[dict]:
        """
        Clips whose post-roll has elapsed, encoded and ready to send.

        `force` drains everything regardless, for shutdown -- a half-collected
        clip of a real crossing is worth more than a tidy exit.

        Encoding happens HERE, once per clip, which is the whole reason the ring
        holds raw frames. A clip that encodes to nothing is counted rather than
        sent: an empty frame list would reach the console as a player with no
        frames and no explanation.
        """
        now = time.time() if now is None else now
        ready: list[_Pending] = []
        waiting: list[_Pending] = []

        for pending in self._pending:
            stale = (time.time() - pending.opened) > MAX_PENDING_AGE_SECONDS
            if force or now >= pending.until or stale:
                ready.append(pending)
            else:
                waiting.append(pending)
        self._pending = waiting

        out: list[dict] = []
        for pending in ready:
            payload = self._encode(pending)
            if payload is None:
                self.dropped_empty += 1
                continue
            self.cut += 1
            out.append(payload)
        return out

    def _encode(self, pending: _Pending) -> Optional[dict]:
        import base64

        frames: list[dict] = []
        for ts, frame, boxes in pending.frames:
            try:
                ok, buffer = cv2.imencode(
                    ".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), self.quality]
                )
                if not ok:
                    continue
                frames.append({
                    # Seconds relative to the crossing, so the console can put
                    # the playhead on it without knowing the wall clock. The
                    # crossing frame is the one nearest zero.
                    "offset": round(ts - pending.at, 3),
                    "jpeg": base64.b64encode(buffer.tobytes()).decode("ascii"),
                    "boxes": boxes,
                })
            except Exception:  # noqa: BLE001
                continue

        if not frames:
            return None

        return {
            "clip_id": pending.clip_id,
            "at": pending.at,
            "fps": self._observed_fps(pending),
            "frames": frames,
        }

    @staticmethod
    def _observed_fps(pending: _Pending) -> float:
        """
        The rate these frames were ACTUALLY captured at, not the configured
        target. A worker managing 4.1 fps must not hand the console a clip
        labelled 6 fps -- the console shows this number to the operator, and a
        wrong one turns an honest rate into a quiet lie about the evidence.
        """
        stamps = [ts for ts, _, _ in pending.frames]
        if len(stamps) < 2:
            return 0.0
        span = stamps[-1] - stamps[0]
        return round((len(stamps) - 1) / span, 2) if span > 0 else 0.0

    def stats(self) -> dict:
        return {
            "buffered": len(self._ring),
            "pending": len(self._pending),
            "cut": self.cut,
            "dropped_empty": self.dropped_empty,
            "ring_bytes": sum(frame.nbytes for _, frame, _ in self._ring),
        }
