"""
RTSP ingest with latest-frame-wins buffering.

WHY THIS EXISTS (you must be able to explain this to a jury):
cv2.VideoCapture.read() pulls frames sequentially from an internal buffer.
If your inference is slower than the camera's FPS, that buffer grows and you
fall further and further behind real time. After 5 minutes your "live" feed
is 90 seconds stale. This is the #1 reason hackathon video demos collapse.

Fix: a reader thread that continuously drains the socket and keeps ONLY the
most recent frame. Inference always operates on the freshest frame available
and old frames are dropped, not queued. Latency stays bounded.

STATUS: prototype-quality, but this pattern is what production uses too.
"""

import threading
import time
import cv2


class StreamReader:
    def __init__(self, source, name="cam", reconnect_delay=3.0,
                 drop=None, loop=False):
        """
        drop=True  -> latest-frame-wins. CORRECT for live RTSP/webcam:
                      bounded latency, old frames discarded.
        drop=False -> block until consumer takes the frame. CORRECT for FILES:
                      you want every frame, and a file has no "real time" to
                      fall behind. Using drop=True on a file silently discards
                      most of your footage and corrupts your evaluation.
        drop=None  -> auto: files get False, live sources get True.
        loop       -> restart a file at EOF instead of treating it as failure.
        """
        # source: RTSP URL, video file path, or webcam index (int)
        if drop is None:
            is_live = isinstance(source, int) or str(source).startswith(
                ("rtsp://", "http://", "https://", "rtmp://"))
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

        # health counters -- these become real numbers in your PPT
        self.frames_read = 0
        self.frames_dropped = 0
        self.reconnects = 0
        self.loop_restarts = 0
        self.last_frame_time = 0.0

    def start(self):
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        return self

    def _open(self):
        cap = cv2.VideoCapture(self.source)
        # Ask FFmpeg for a shallow buffer. Not honoured by every backend,
        # which is exactly why we also drop frames ourselves.
        try:
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        except Exception:
            pass
        return cap

    def _loop(self):
        cap = self._open()
        while self._running:
            if not cap.isOpened():
                # Camera failure path. Real BOP cameras drop out constantly.
                if self.loop and not self.drop:
                    # A demo file looping is intentional playback, not a lost
                    # camera connection. Keep it out of health reporting.
                    self.loop_restarts += 1
                else:
                    self.reconnects += 1
                time.sleep(self.reconnect_delay)
                cap.release()
                cap = self._open()
                continue

            ok, frame = cap.read()
            if not ok:
                if not self.drop and not self.loop:
                    # File source reached its end. Not a failure.
                    self.eof = True
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
                        # previous frame was never consumed -> dropped
                        self.frames_dropped += 1
                    self._frame = frame
                    self._frame_id += 1
                    self.last_frame_time = time.time()
            else:
                # backpressure: wait for the consumer, lose nothing
                while self._running:
                    with self._lock:
                        if self._frame is None:
                            self._frame = frame
                            self._frame_id += 1
                            self.last_frame_time = time.time()
                            break
                    time.sleep(0.002)

        cap.release()

    def read(self):
        """Return (frame_id, frame) or (None, None) if nothing new."""
        with self._lock:
            if self._frame is None:
                return None, None
            frame = self._frame
            fid = self._frame_id
            self._frame = None  # mark consumed
            return fid, frame

    def stats(self):
        total = max(self.frames_read, 1)
        return {
            "camera": self.name,
            "frames_read": self.frames_read,
            "frames_dropped": self.frames_dropped,
            "drop_rate": round(self.frames_dropped / total, 3),
            "reconnects": self.reconnects,
            "loop_restarts": self.loop_restarts,
            "age_s": round(time.time() - self.last_frame_time, 2)
            if self.last_frame_time else None,
        }

    def stop(self):
        self._running = False
        if self._thread:
            self._thread.join(timeout=2.0)
