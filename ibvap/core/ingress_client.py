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
from datetime import datetime, timezone


class IngressClient:
    def __init__(self, url, camera_id, source_id="ibvap-ingest", timeout=1.0):
        self.url = url.rstrip("/")
        self.camera_id = camera_id
        self.source_id = source_id
        self.timeout = timeout
        self.sent = 0
        self.failed = 0
        self._warned = False
        self._lock = threading.Lock()
        self._queue = queue.Queue(maxsize=1)
        self._running = True
        self._thread = threading.Thread(target=self._worker, daemon=True)
        self._thread.start()

    @staticmethod
    def _occurred_at():
        return datetime.now(timezone.utc).isoformat(timespec="milliseconds") \
            .replace("+00:00", "Z")

    def _to_detection(self, person, w, h):
        tid = person["track_id"]
        if tid is None:
            return None
        x1, y1, x2, y2 = person["bbox"]
        return {
            "track_ref": str(tid),
            "class": "person",
            "confidence": person["conf"],
            "bbox": [x1 / w, y1 / h, (x2 - x1) / w, (y2 - y1) / h],
        }

    def send(self, persons, frame_shape):
        """Non-blocking. persons: PersonTracker.update() output."""
        h, w = frame_shape[:2]
        detections = [d for d in (self._to_detection(p, w, h) for p in persons)
                      if d is not None]
        if not detections:
            return

        payload = {
            "camera_id": self.camera_id,
            "occurred_at": self._occurred_at(),
            "simulated": False,
            "source_id": self.source_id,
            "detections": detections,
        }
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
