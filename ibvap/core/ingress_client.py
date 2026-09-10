"""
Bridge from this L1 vision pipeline to the backend's detection ingress.

WHY THIS SHAPE: backend/src/l4/hooks.ts documents the seam -- POST
/hooks/ingress/detections is the ONLY door a detection enters through, and
backend/src/sim/simulator.ts already posts through that exact shape as a
stand-in "detector". Its own comment says the plan explicitly: a real
detector points at that endpoint and the simulator file gets deleted --
nothing else in the backend changes. This module produces that same shape
from PersonTracker.update() output so this pipeline is a drop-in replacement
for the simulator, not a fork of it.

CONTRACT (backend/src/core/types.ts -- do not drift from this silently):
    bbox is [x, y, w, h], NORMALISED 0..1, top-left corner. Pixel (x1,y1,x2,y2)
    must be converted using the frame's own width/height.
    track_ref must be a non-empty string -- an unconfirmed detection
    (track_id is None) has none yet and must be dropped, not sent.
    camera_id must match a camera already seeded in the backend's db
    (see backend/src/db/seed.ts) or the backend rejects the whole frame.

WHY A BACKGROUND THREAD: same reasoning as core/ingest.py's reader thread --
a blocked socket call must never stall the detection loop. Measured on this
machine: a single failed connect to a closed port took ~2s despite a 1s
socket timeout (Windows connect-refused latency). Calling send() inline
would have cut pipeline FPS by roughly that much per detector call whenever
the backend is unreachable. A queue of size 1 means only the newest frame's
detections are ever in flight -- an older send still in progress is simply
superseded, never queued up behind, matching the same drop=True latest-wins
policy core/ingest.py uses for live sources.

STATUS: prototype.
"""

import json
import queue
import threading
import urllib.error
import urllib.request
import time
from datetime import datetime, timezone


def normalise(subject, width, height, run_id, class_):
    """
    The ONE place a pixel box becomes the wire format. Both channels call it,
    and both this repo's domains (people, vehicles) call it too.

    WHY IT IS SHARED: the hot path (core/box_channel.py -> browser overlay) and
    the cold path (this file -> backend fence) carry the same detections. Two
    functions producing "the box" is how a system ends up with two conventions,
    and a wrongly-converted box still looks like a box — the failure is silent.
    One function, one convention, every channel and every domain.

    WHY `class_` IS REQUIRED, NOT DEFAULTED: this function used to hardcode
    "class": "person", then got edited in place to hardcode "class": "vehicle"
    -- each change silently broke whichever domain wasn't being worked on at
    the time, and nothing failed loudly when it happened. A required parameter
    turns that into an immediate TypeError at the call site instead of a
    detection silently mislabelled downstream. Pass "person" or "vehicle"
    explicitly; do not give this a default.

    CONTRACT (backend/src/core/types.ts): [x, y, w, h], normalised 0..1,
    top-left corner. Normalised is what lets detection run on a 480p substream
    while the console displays 720p, and what lets a zone survive a camera swap.

    WHY run_id PREFIXES THE REF: ByteTrack reuses integer ids once a track dies
    and restarts from 1 when this process restarts. The backend keys its fence
    memory on (camera_id, track_ref) and has a UNIQUE constraint on the pair
    (backend/src/db/schema.sql), so a bare id means a new subject can inherit a
    dead one's pending zone crossing. Scoping the ref to this run makes that
    impossible by construction rather than by luck.

    Returns None for an unconfirmed detection — the tracker has not issued an
    id yet, and the backend requires a non-empty track_ref.

    `subject` may carry two optional, domain-specific extras, forwarded as-is
    rather than gated on `class_` so a domain can add its own without editing
    this function again:
        "class"  (vehicle domain) -> re-keyed to wire field "vehicle_type",
                 since the wire "class" here is the category ("vehicle"),
                 not the COCO label ("car"/"truck"/...).
        "plate"  (vehicle domain) -> {text, confidence, bbox} for an ANPR read
                 cascaded inside this box, forwarded unchanged.
    """
    track_id = subject["track_id"]
    if track_id is None:
        return None
    x1, y1, x2, y2 = subject["bbox"]
    result = {
        "track_ref": f"{run_id}:{track_id}",
        "class": class_,
        "confidence": round(float(subject["conf"]), 4),
        "bbox": [x1 / width, y1 / height,
                 (x2 - x1) / width, (y2 - y1) / height],
    }
    vehicle_type = subject.get("class")
    if vehicle_type:
        result["vehicle_type"] = vehicle_type
    plate = subject.get("plate")
    if plate:
        px1, py1, px2, py2 = plate["bbox"]
        result["plate"] = {
            "text": plate["text"],
            "confidence": round(float(plate["confidence"]), 4),
            "bbox": [px1 / width, py1 / height,
                     (px2 - px1) / width, (py2 - py1) / height],
        }
    return result


class IngressClient:
    def __init__(self, url, camera_id, class_, source_id="ibvap-ingest",
                 timeout=1.0, run_id="r0", simulated=False):
        """
        `class_` is required, not defaulted, for the same reason normalise()
        requires it: this class is shared between the people and vehicle
        domains, and a silently-wrong default is how a detection ends up
        mislabelled without anything failing loudly. Pass "person" or
        "vehicle" explicitly.
        """
        self.url = url.rstrip("/")
        self.camera_id = camera_id
        self.class_ = class_
        self.source_id = source_id
        self.timeout = timeout
        self.run_id = run_id
        # Honesty flag, set once at the adapter so it cannot be forgotten
        # downstream. A looping clip is not a camera and the event says so;
        # a real RTSP camera or webcam sets this False. Derived from the
        # manifest's source kind, never hand-typed per call.
        self.simulated = simulated
        self.sent = 0
        self.failed = 0
        self._warned = False
        self._lock = threading.Lock()
        self._queue = queue.Queue(maxsize=1)
        self._recent_plates = {}
        self._running = True
        self._thread = threading.Thread(target=self._worker, daemon=True)
        self._thread.start()

    @staticmethod
    def _occurred_at():
        return datetime.now(timezone.utc).isoformat(timespec="milliseconds") \
            .replace("+00:00", "Z")

    def send(self, persons, frame_shape, capture_mono=None, detections=None):
        """
        Non-blocking. persons: PersonTracker.update() output.

        `detections` lets a caller that has ALREADY normalised (to feed the box
        channel in the same tick) pass the result straight through instead of
        converting the same boxes twice per frame.
        """
        if detections is None:
            h, w = frame_shape[:2]
            detections = [d for d in
                          (normalise(p, w, h, self.run_id, self.class_) for p in persons)
                          if d is not None]
        if not detections:
            return

        # A stable tracked vehicle is visible in several detector calls. Keep
        # its plate in the overlay, but persist one ANPR observation at most
        # once every eight seconds so the database is not flooded with clones.
        now = time.monotonic()
        outbound = []
        for detection in detections:
            item = dict(detection)
            plate = item.get("plate")
            if plate:
                key = f"{item['track_ref']}:{plate['text']}"
                if now - self._recent_plates.get(key, 0) < 8.0:
                    item.pop("plate", None)
                else:
                    self._recent_plates[key] = now
            outbound.append(item)
        detections = outbound

        payload = {
            "camera_id": self.camera_id,
            "occurred_at": self._occurred_at(),
            "simulated": self.simulated,
            "source_id": self.source_id,
            "detections": detections,
        }
        # A monotonic capture clock for the backend's wait-and-confirm maths.
        # WHY: the fence measures how long a crossing has been held by
        # differencing timestamps. Wall clock at a post with no NTP can step,
        # and a step makes a pending crossing either confirm instantly or never
        # confirm at all. occurred_at stays for display and storage; this is
        # what the state machine should count on.
        if capture_mono is not None:
            payload["capture_mono"] = round(capture_mono, 3)
        # Superseding drop, not backpressure: the freshest frame always wins.
        try:
            self._queue.get_nowait()
        except queue.Empty:
            pass
        try:
            self._queue.put_nowait(payload)
        except queue.Full:
            pass

    def _worker(self):
        while self._running:
            try:
                payload = self._queue.get(timeout=0.5)
            except queue.Empty:
                continue

            req = urllib.request.Request(
                f"{self.url}/hooks/ingress/detections",
                data=json.dumps(payload).encode("utf-8"),
                headers={"content-type": "application/json"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    resp.read()
                with self._lock:
                    self.sent += 1
            except Exception as e:
                with self._lock:
                    self.failed += 1
                if not self._warned:
                    print(f"[warn] backend ingress unreachable at {self.url}: {e}\n"
                          f"       continuing without it -- run summary will "
                          f"report total send failures.")
                    self._warned = True

    def stop(self):
        self._running = False
        self._thread.join(timeout=2.0)
