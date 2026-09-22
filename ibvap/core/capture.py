"""
RTSP capture: a threaded reader that always serves the latest frame.

WHY THIS EXISTS (you must be able to explain this to a jury):
cv2.VideoCapture.read() pulls frames sequentially from an internal buffer. If
inference is slower than the camera's FPS — and at a capped 5-10 fps cadence
against a 25 fps stream it always is — that buffer grows and the pipeline falls
further and further behind real time. After five minutes a "live" feed is 90
seconds stale. This is the #1 reason hackathon video demos collapse.

Fix: a reader thread that continuously drains the socket and keeps ONLY the
most recent frame. Inference always operates on the freshest frame available;
old frames are dropped, not queued. Latency stays bounded.

FILES ARE THE OPPOSITE CASE AND THIS IS NOT A DETAIL. A file has no real time
to fall behind, so dropping frames there silently discards most of the footage
and corrupts any evaluation run against it. Using drop=True on a file once
discarded ~97 % of frames and faked 22 camera "reconnects". That bug happened,
was fixed, and `drop=None` auto-selecting per source is the fix. Do not
"simplify" it to one behaviour.

STATUS: prototype-quality, but this pattern is what production uses too.
"""

import os
import threading
import time

import cv2

LIVE_SCHEMES = ("rtsp://", "http://", "https://", "rtmp://")

# OpenCV's FFmpeg backend defaults to UDP for RTSP, which drops packets under
# contention -- and five workers each pulling their own camera from the same
# loopback hub is exactly that contention. A dropped UDP packet mid-frame
# does not fail cleanly: ffmpeg decodes around the hole and prints exactly
# the "corrupted macroblock" / "invalid level prefix" spam this caused,
# frame after frame, on every camera at once. TCP is lossless -- slightly
# higher latency, irrelevant at this service's 5-10 fps cadence -- and it is
# what actually fixed it. This is a process-wide FFmpeg option, not a
# per-capture one, so it is set once, not inside the loop that reconnects.
os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp")


class RTSPStream:
    """
    One video source, read on its own thread.

    Despite the name it takes a file path or a webcam index too — the point of
    the media hub is that nothing downstream can tell a looping clip from a
    camera on a wall, and that has to hold here as well.
    """

    def __init__(self, source, name="cam", reconnect_delay=3.0, drop=None, loop=False):
        """
        drop=True  -> latest-frame-wins. CORRECT for live RTSP/webcam:
                      bounded latency, old frames discarded.
        drop=False -> block until the consumer takes the frame. CORRECT for
                      FILES: every frame matters and a file cannot fall behind.
        drop=None  -> auto: files get False, live sources get True.
        loop       -> restart a file at EOF instead of treating it as failure.
        """
        if drop is None:
            is_live = isinstance(source, int) or str(source).startswith(LIVE_SCHEMES)
            drop = is_live
        self.drop = drop
        self.loop = loop
        self.eof = False
        self.source = source
        self.name = name
        self.reconnect_delay = reconnect_delay

        self._frame = None
        self._frame_id = 0
        self._lock = threading.Lock()
        self._running = False
        self._thread = None

        # Health counters. These become real numbers in the run summary, and
        # they are the honest answer to "was the camera actually up?".
        self.frames_read = 0
        self.frames_dropped = 0
        self.reconnects = 0
        self.loop_restarts = 0
        self.last_frame_time = 0.0
        self.opened_ok = False

    # ── lifecycle ────────────────────────────────────────────────────────

    def start(self):
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True, name=f"cap:{self.name}")
        self._thread.start()
        return self

    def stop(self):
        self._running = False
        if self._thread:
            self._thread.join(timeout=2.0)

    def _open(self):
        cap = cv2.VideoCapture(self.source)
        # Ask FFmpeg for a shallow buffer. Not honoured by every backend, which
        # is exactly why we also drop frames ourselves.
        try:
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        except Exception:
            pass
        return cap

    def _loop(self):
        cap = self._open()
        while self._running:
            if not cap.isOpened():
                # Camera failure path. Real BOP cameras drop out constantly,
                # and the vision service is the only thing that can see it
                # happen — which is why a reconnect becomes a camera_health
                # durable event upstream in main.py.
                if self.loop and not self.drop:
                    # A demo file looping is intentional playback, not a lost
                    # camera. Keep it out of health reporting.
                    self.loop_restarts += 1
                else:
                    self.reconnects += 1
                time.sleep(self.reconnect_delay)
                cap.release()
                cap = self._open()
                continue

            self.opened_ok = True
            ok, frame = cap.read()
            if not ok:
                if not self.drop and not self.loop:
                    self.eof = True  # file reached its end. Not a failure.
                    break
                self.reconnects += 1
                cap.release()
                time.sleep(self.reconnect_delay if self.drop else 0)
                cap = self._open()
                continue

            self.frames_read += 1

            if self.drop:
                with self._lock:
                    if self._frame is not None:
                        self.frames_dropped += 1  # never consumed
                    self._frame = frame
                    self._frame_id += 1
                    self.last_frame_time = time.time()
            else:
                # Backpressure: wait for the consumer, lose nothing.
                while self._running:
                    with self._lock:
                        if self._frame is None:
                            self._frame = frame
                            self._frame_id += 1
                            self.last_frame_time = time.time()
                            break
                    time.sleep(0.002)

        cap.release()

    # ── consumer side ────────────────────────────────────────────────────

    def read(self):
        """Return (frame_id, frame), or (None, None) if nothing new."""
        with self._lock:
            if self._frame is None:
                return None, None
            frame = self._frame
            fid = self._frame_id
            self._frame = None  # mark consumed
            return fid, frame

    @property
    def healthy(self) -> bool:
        """
        Has a frame arrived recently enough to call this camera alive?

        Deliberately generous: at a capped cadence the reader still runs at
        full stream rate, so anything beyond a couple of seconds of silence is
        a real stall rather than a slow consumer.
        """
        if not self.last_frame_time:
            return False
        return (time.time() - self.last_frame_time) < 5.0

    def stats(self):
        total = max(self.frames_read, 1)
        return {
            "camera": self.name,
            "frames_read": self.frames_read,
            "frames_dropped": self.frames_dropped,
            "drop_rate": round(self.frames_dropped / total, 3),
            "reconnects": self.reconnects,
            "loop_restarts": self.loop_restarts,
            "age_s": round(time.time() - self.last_frame_time, 2) if self.last_frame_time else None,
        }
