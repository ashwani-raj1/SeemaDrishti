"""
IBVAP vision service — the L1 half of the backend.

    python ibvap/service.py                        # cameras from .env
    python ibvap/service.py --cameras cam_farm_gate
    python ibvap/service.py --no-backend           # overlay only, no ingress

WHAT THIS IS: the process that turns video into detections. It pulls RTSP from
the media hub, runs CPU-only YOLO11n + ByteTrack vehicle tracking and cascaded
number-plate OCR per camera, and emits the same
detections down two channels that have nothing else in common:

    hot   core/box_channel.py  -> browser   every detector call, ephemeral
    cold  core/ingress_client  -> backend   every detector call, durable

WHAT IT IS NOT: it does not know what a zone is, what a severity is, or what
an incident is. That knowledge lives in the edge node, one layer up. Pushing
it down here would put force-specific configuration into the pixel pipeline —
and the whole reason the backend has no "if this is the Navy" branch is that
nothing below it needs one.

ONE TRACKER PER CAMERA, DELIBERATELY: ultralytics keeps ByteTrack state on the
model object and `persist=True` means "this frame continues the previous
sequence". Sharing one tracker across cameras would interleave four unrelated
scenes into one association problem and produce constant id switches.
core/person.py's own docstring flags per-camera instances as the missing
production piece; this is that piece. The cost is N models resident — which is
the real reason worker count is a per-machine setting rather than a constant.

RUNNING FOUR WORKERS: on one CPU-only box they contend for the same cores and
each one's frame rate falls roughly in proportion. The design answer is one
worker per machine — every laptop reads the same media/cameras.yml and a
different IBVAP_WORKER_CAMERAS. Measure before assuming either layout works
(claude.md §7); this file prints the numbers you need at exit.

STATUS: prototype.
"""

import argparse
import os
import signal
import sys
import threading
import time
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from core.box_channel import BoxChannel
from core.ingest import StreamReader
from core.ingress_client import IngressClient, normalise
from core.vehicle import VehicleTracker
from core.plate import PlateDetector
from core.settings import Settings, cameras_for_this_machine


class CameraWorker(threading.Thread):
    """
    One camera, one thread, one tracker.

    A blocking thread rather than a coroutine because the loop is dominated by
    a synchronous YOLO call — there is nothing for an event loop to interleave,
    and threads keep the code readable for six people who each have to defend
    it separately (claude.md §9).
    """

    def __init__(self, camera, settings, boxes, run_id, post=True):
        super().__init__(daemon=True, name=camera["id"])
        self.camera = camera
        self.id = camera["id"]
        self.settings = settings
        self.boxes = boxes
        self.run_id = run_id
        self.post = post

        self.reader = None
        self.tracker = None
        self.plates = None
        self.ingress = None
        # NOT `_stop`: threading.Thread uses that name internally, and
        # shadowing it breaks join() with a confusing TypeError.
        self._halt = threading.Event()

        # Real numbers, printed at exit. claude.md §7: never quote a figure
        # that was not measured on the machine that ran it.
        self.frames = 0
        self.detector_calls = 0
        self.detector_seconds = 0.0
        self.started_at = None

    # ── lifecycle ────────────────────────────────────────────────────────

    def stop(self):
        self._halt.set()

    def run(self):
        settings = self.settings
        url = settings.rtsp_url(self.id)
        kind = (self.camera.get("source") or {}).get("kind", "file")

        # A looping clip is not a camera, and the event log says so. Set once
        # here from the manifest so no call site has to remember.
        simulated = kind in ("file",)

        print(f"[{self.id}] pulling {url}  (source: {kind}"
              f"{', flagged simulated' if simulated else ''})")

        # drop=True: this is a live source. If inference is slower than the
        # stream, the decoder buffer grows and a "live" feed silently goes
        # stale — the #1 cause of a collapsed demo (core/ingest.py).
        self.reader = StreamReader(url, name=self.id, drop=True).start()
        self.tracker = VehicleTracker(
            weights=settings.weights,
            imgsz=settings.imgsz,
            conf=settings.conf,
        )
        self.plates = PlateDetector()
        if self.post:
            self.ingress = IngressClient(
                settings.backend_url,
                self.id,
                "vehicle",
                source_id=f"vision.{self.run_id}",
                run_id=self.run_id,
                simulated=simulated,
            )

        self.started_at = time.monotonic()
        detect_every = settings.detect_every
        frame_index = 0

        try:
            while not self._halt.is_set():
                _, frame = self.reader.read()
                if frame is None:
                    time.sleep(0.002)
                    continue

                frame_index += 1
                self.frames += 1
                if frame_index % detect_every:
                    continue

                # Arrival time, not true capture time — the difference is the
                # decode and hand-off delay, which drop=True keeps bounded.
                # Monotonic on purpose: it cannot step backwards when the host
                # clock is corrected, which is what the backend's confirm
                # window counts on.
                capture_mono = time.monotonic()

                t0 = time.monotonic()
                vehicles = self.tracker.update(frame)
                for vehicle in vehicles:
                    vehicle["plate"] = self.plates.read_for_vehicle(frame, vehicle)
                self.detector_seconds += time.monotonic() - t0
                self.detector_calls += 1

                height, width = frame.shape[:2]
                detections = [
                    d for d in (normalise(vehicle, width, height, self.run_id, "vehicle")
                                for vehicle in vehicles)
                    if d is not None
                ]

                # Hot path first: the overlay is what a human is watching, and
                # it costs a queue put. Sent even when empty — an empty list is
                # how the overlay learns the frame cleared.
                self.boxes.publish(self.id, detections, capture_mono)

                if self.ingress:
                    self.ingress.send(vehicles, frame.shape,
                                      capture_mono=capture_mono,
                                      detections=detections)
        finally:
            if self.reader:
                self.reader.stop()
            if self.ingress:
                self.ingress.stop()

    # ── reporting ────────────────────────────────────────────────────────

    def report(self):
        elapsed = (time.monotonic() - self.started_at) if self.started_at else 0
        source = self.reader.stats() if self.reader else {}
        return {
            "camera": self.id,
            "frames": self.frames,
            "fps": round(self.frames / elapsed, 2) if elapsed else 0.0,
            "detector_calls": self.detector_calls,
            "detector_ms": round(
                self.detector_seconds / self.detector_calls * 1000, 1
            ) if self.detector_calls else 0.0,
            "src_drop_rate": source.get("drop_rate"),
            "reconnects": source.get("reconnects"),
            "posted": self.ingress.sent if self.ingress else 0,
            "post_failed": self.ingress.failed if self.ingress else 0,
        }


def print_report(workers, boxes, elapsed):
    print("\n--- RUN SUMMARY (measured on this machine, this run) ---")
    print(f"wall time : {elapsed:.1f}s")
    header = (f"{'camera':<18}{'fps':>7}{'det ms':>9}{'calls':>8}"
              f"{'drop':>7}{'recon':>7}{'posted':>8}{'failed':>8}")
    print(header)
    print("-" * len(header))
    for worker in workers:
        r = worker.report()
        drop = r["src_drop_rate"]
        print(f"{r['camera']:<18}{r['fps']:>7.2f}{r['detector_ms']:>9.1f}"
              f"{r['detector_calls']:>8}"
              f"{(f'{drop*100:.0f}%' if drop is not None else '-'):>7}"
              f"{str(r['reconnects'] or 0):>7}"
              f"{r['posted']:>8}{r['post_failed']:>8}")
    print(f"\nbox channel: {boxes.stats()}")
    print("\nThese are the only performance figures you may quote "
          "(claude.md §7).")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cameras",
                    help="comma-separated camera ids, overriding "
                         "IBVAP_WORKER_CAMERAS")
    ap.add_argument("--no-backend", action="store_true",
                    help="skip the ingress post; overlay only")
    ap.add_argument("--imgsz", type=int, help="override IBVAP_IMGSZ")
    ap.add_argument("--detect-every", type=int, help="override IBVAP_DETECT_EVERY")
    ap.add_argument("--seconds", type=int, default=0,
                    help="stop after N seconds and print the summary. This is "
                         "how you get comparable baseline numbers off each "
                         "team laptop (claude.md §12.3) — same clip, same "
                         "flags, same duration, one row per machine.")
    args = ap.parse_args()

    env = {}
    if args.cameras:
        env["IBVAP_WORKER_CAMERAS"] = args.cameras
    if args.imgsz:
        env["IBVAP_IMGSZ"] = str(args.imgsz)
    if args.detect_every:
        env["IBVAP_DETECT_EVERY"] = str(args.detect_every)
    os.environ.update(env)

    settings = Settings()
    cameras = cameras_for_this_machine(settings)
    if not cameras:
        raise SystemExit(
            "[service] no cameras to run.\n"
            "          Every camera in media/cameras.yml has detect: false, or\n"
            "          IBVAP_WORKER_CAMERAS names none of them."
        )

    # Short and per-process: it scopes every track_ref this run emits, so a
    # restart cannot collide with the ids the previous run left in the backend.
    run_id = uuid.uuid4().hex[:4]

    print(f"[service] run {run_id} — {len(cameras)} camera(s)")
    print(f"[service] media   {settings.media_host}:{settings.rtsp_port}")
    print(f"[service] backend {settings.backend_url}"
          f"{'  (disabled)' if args.no_backend else ''}")
    print(f"[service] budget  imgsz={settings.imgsz} "
          f"detect_every={settings.detect_every} conf={settings.conf}")
    if len(cameras) > 1:
        print(f"[service] NOTE: {len(cameras)} trackers on one machine share "
              f"its cores.\n"
              f"          If fps is too low, give each laptop one camera via "
              f"IBVAP_WORKER_CAMERAS\n"
              f"          rather than lowering accuracy first.")

    boxes = BoxChannel(settings.boxes_bind, settings.boxes_port).start()

    workers = [
        CameraWorker(camera, settings, boxes, run_id, post=not args.no_backend)
        for camera in cameras
    ]
    started = time.monotonic()
    for worker in workers:
        worker.start()

    stopping = threading.Event()

    def shutdown(*_):
        stopping.set()

    signal.signal(signal.SIGINT, shutdown)
    try:
        signal.signal(signal.SIGTERM, shutdown)
    except (AttributeError, ValueError):
        pass  # not available on every Windows console host

    deadline = (time.monotonic() + args.seconds) if args.seconds else None
    print(f"[service] running{f' for {args.seconds}s' if deadline else ''}. "
          f"ctrl-c to stop.\n")
    try:
        while not stopping.is_set():
            if not any(w.is_alive() for w in workers):
                print("[service] every worker exited")
                break
            if deadline and time.monotonic() >= deadline:
                print(f"[service] {args.seconds}s elapsed")
                break
            stopping.wait(0.5)
    except KeyboardInterrupt:
        pass

    for worker in workers:
        worker.stop()
    for worker in workers:
        worker.join(timeout=5.0)

    print_report(workers, boxes, time.monotonic() - started)
    boxes.stop()


if __name__ == "__main__":
    main()
