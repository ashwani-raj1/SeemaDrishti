"""
IBVAP people service -- the L1 half of the backend, for humans specifically.

    python ibvap/people_service.py                        # cameras from .env
    python ibvap/people_service.py --cameras cam_farm_gate
    python ibvap/people_service.py --no-backend           # overlay only, no ingress
    python ibvap/people_service.py --no-face              # skip the face stage

WHY THIS FILE EXISTS, SEPARATELY FROM service.py: this repo's original
service.py did exactly this job -- YOLO11n + ByteTrack person tracking,
cascaded YuNet faces -- until the ANPR work replaced its detector with
VehicleTracker/PlateDetector in place, reusing the filename. That silently
deleted the platform's #1 scope item (human detection + tracking,
ibvap/claude.md SCOPE) to make room for its #4 (ANPR). Splitting the two
domains into their own files is what stops the next feature from doing the
same thing again: vehicles get service.py + run.py, people get this file +
people_run.py, and neither can overwrite the other by editing "the" entry
point.

WHAT THIS IS: the process that turns video into people. It pulls RTSP from
the media hub, runs CPU-only YOLO11n + ByteTrack person tracking and cascaded
YuNet face detection per camera, and emits detections down two channels that
have nothing else in common:

    hot   core/box_channel.py  -> browser   every detector call, ephemeral
    cold  core/ingress_client  -> backend   every detector call, durable

WHAT IT IS NOT: it does not know what a zone is, what a severity is, or what
an incident is. That knowledge lives in the edge node, one layer up.

ONE TRACKER PER CAMERA, DELIBERATELY: ultralytics keeps ByteTrack state on
the model object and `persist=True` means "this frame continues the previous
sequence". Sharing one tracker across cameras would interleave four unrelated
scenes into one association problem and produce constant id switches. The
cost is N models resident -- which is the real reason worker count is a
per-machine setting rather than a constant (IBVAP_WORKER_CAMERAS).

FACES ARE NOT AN INDEPENDENT TRACK: a face is only ever found inside an
already-tracked person's box (core/face.py), so it has no ByteTrack identity
of its own. Its track_ref is derived from the owning person's -- see
`normalise_face` below -- so it is attributable without pretending a face is
a second thing that can cross a zone on its own.

RUNNING FOUR WORKERS: on one CPU-only box they contend for the same cores and
each one's frame rate falls roughly in proportion. The design answer is one
worker per machine -- every laptop reads the same media/cameras.yml and a
different IBVAP_WORKER_CAMERAS. Measure before assuming either layout works
(claude.md SS7); this file prints the numbers you need at exit.

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
from core.person import PersonTracker
from core.face import FaceDetector
from core.settings import Settings, cameras_for_this_machine


def normalise_face(face, width, height, run_id):
    """
    The face-channel counterpart to ingress_client.normalise().

    Kept local rather than added to that shared function: a face's wire shape
    (face_bbox/score, no independent track_id) does not fit the person/vehicle
    contract normalise() already serves two domains with, and this stays a
    small, self-contained addition rather than a third special case bolted
    onto code the vehicle/ANPR side also depends on.

    track_ref is `<run_id>:<person track_id>:face` -- deterministic from the
    owning person, not a second identity. Two faces never collide because
    core/face.py finds at most one per person per call.
    """
    person_track_id = face["track_id"]
    if person_track_id is None:
        return None
    x1, y1, x2, y2 = face["face_bbox"]
    return {
        "track_ref": f"{run_id}:{person_track_id}:face",
        "class": "face",
        "confidence": round(float(face["score"]), 4),
        "bbox": [x1 / width, y1 / height, (x2 - x1) / width, (y2 - y1) / height],
    }


class CameraWorker(threading.Thread):
    """
    One camera, one thread, one tracker.

    A blocking thread rather than a coroutine because the loop is dominated by
    a synchronous YOLO call -- there is nothing for an event loop to
    interleave, and threads keep the code readable for six people who each
    have to defend it separately (claude.md SS9).
    """

    def __init__(self, camera, settings, boxes, run_id, post=True,
                 detect_faces=True, face_every=10):
        super().__init__(daemon=True, name=camera["id"])
        self.camera = camera
        self.id = camera["id"]
        self.settings = settings
        self.boxes = boxes
        self.run_id = run_id
        self.post = post
        self.detect_faces = detect_faces
        self.face_every = max(1, face_every)

        self.reader = None
        self.tracker = None
        self.face_det = None
        self.ingress = None
        # NOT `_stop`: threading.Thread uses that name internally, and
        # shadowing it breaks join() with a confusing TypeError.
        self._halt = threading.Event()

        # Real numbers, printed at exit. claude.md SS7: never quote a figure
        # that was not measured on the machine that ran it.
        self.frames = 0
        self.detector_calls = 0
        self.detector_seconds = 0.0
        self.started_at = None

    # -- lifecycle ------------------------------------------------------

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
        # stale -- the #1 cause of a collapsed demo (core/ingest.py).
        self.reader = StreamReader(url, name=self.id, drop=True).start()
        self.tracker = PersonTracker(
            weights=settings.weights,
            imgsz=settings.imgsz,
            conf=settings.conf,
        )
        if self.detect_faces:
            try:
                self.face_det = FaceDetector(settings.get(
                    "IBVAP_FACE_MODEL", "data/face_detection_yunet_2023mar.onnx"))
            except FileNotFoundError as e:
                print(f"[{self.id}] [warn] face stage disabled:\n{e}")
                self.face_det = None
        if self.post:
            self.ingress = IngressClient(
                settings.backend_url,
                self.id,
                "person",
                source_id=f"vision.{self.run_id}",
                run_id=self.run_id,
                simulated=simulated,
            )

        self.started_at = time.monotonic()
        detect_every = settings.detect_every
        frame_index = 0
        persons = []

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

                # Arrival time, not true capture time -- the difference is
                # the decode and hand-off delay, which drop=True keeps
                # bounded. Monotonic on purpose: it cannot step backwards
                # when the host clock is corrected, which is what the
                # backend's confirm window counts on.
                capture_mono = time.monotonic()

                t0 = time.monotonic()
                persons = self.tracker.update(frame)
                self.detector_seconds += time.monotonic() - t0
                self.detector_calls += 1

                height, width = frame.shape[:2]
                detections = [
                    d for d in (normalise(p, width, height, self.run_id, "person")
                                for p in persons)
                    if d is not None
                ]

                # Cascaded, coarser than person detection on purpose (claude.md
                # SS5): a face only needs ONE good sighting per track, not
                # one every frame, and it is only ever searched inside an
                # already-tracked person's box -- never full-frame.
                if self.face_det and persons and frame_index % self.face_every == 0:
                    faces = self.face_det.detect_for_persons(frame, persons)
                    detections += [
                        d for d in (normalise_face(f, width, height, self.run_id)
                                    for f in faces)
                        if d is not None
                    ]

                # Hot path first: the overlay is what a human is watching,
                # and it costs a queue put. Sent even when empty -- an empty
                # list is how the overlay learns the frame cleared.
                self.boxes.publish(self.id, detections, capture_mono)

                if self.ingress:
                    self.ingress.send(persons, frame.shape,
                                      capture_mono=capture_mono,
                                      detections=detections)
        finally:
            if self.reader:
                self.reader.stop()
            if self.ingress:
                self.ingress.stop()

    # -- reporting --------------------------------------------------------

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
          "(claude.md SS7).")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cameras",
                    help="comma-separated camera ids, overriding "
                         "IBVAP_WORKER_CAMERAS")
    ap.add_argument("--no-backend", action="store_true",
                    help="skip the ingress post; overlay only")
    ap.add_argument("--no-face", action="store_true",
                    help="skip face detection entirely")
    ap.add_argument("--face-every", type=int, default=10,
                    help="run the face stage every Nth detector call -- "
                         "faces need one good sighting per track, not every "
                         "frame")
    ap.add_argument("--boxes-port", type=int,
                    help="override IBVAP_BOXES_PORT -- set this to run "
                         "alongside service.py (vehicles) on the same "
                         "machine without both binding the same port")
    ap.add_argument("--imgsz", type=int, help="override IBVAP_IMGSZ")
    ap.add_argument("--detect-every", type=int, help="override IBVAP_DETECT_EVERY")
    ap.add_argument("--seconds", type=int, default=0,
                    help="stop after N seconds and print the summary. This is "
                         "how you get comparable baseline numbers off each "
                         "team laptop (claude.md SS12.3) -- same clip, same "
                         "flags, same duration, one row per machine.")
    args = ap.parse_args()

    env = {}
    if args.cameras:
        env["IBVAP_WORKER_CAMERAS"] = args.cameras
    if args.imgsz:
        env["IBVAP_IMGSZ"] = str(args.imgsz)
    if args.detect_every:
        env["IBVAP_DETECT_EVERY"] = str(args.detect_every)
    if args.boxes_port:
        env["IBVAP_BOXES_PORT"] = str(args.boxes_port)
    os.environ.update(env)

    settings = Settings()
    cameras = cameras_for_this_machine(settings)
    if not cameras:
        raise SystemExit(
            "[people_service] no cameras to run.\n"
            "          Every camera in media/cameras.yml has detect: false, or\n"
            "          IBVAP_WORKER_CAMERAS names none of them."
        )

    # Short and per-process: it scopes every track_ref this run emits, so a
    # restart cannot collide with the ids the previous run left in the backend.
    run_id = uuid.uuid4().hex[:4]

    print(f"[people_service] run {run_id} -- {len(cameras)} camera(s)")
    print(f"[people_service] media   {settings.media_host}:{settings.rtsp_port}")
    print(f"[people_service] backend {settings.backend_url}"
          f"{'  (disabled)' if args.no_backend else ''}")
    print(f"[people_service] boxes   :{settings.boxes_port}")
    print(f"[people_service] budget  imgsz={settings.imgsz} "
          f"detect_every={settings.detect_every} conf={settings.conf} "
          f"face={'off' if args.no_face else f'every {args.face_every}'}")
    if len(cameras) > 1:
        print(f"[people_service] NOTE: {len(cameras)} trackers on one machine "
              f"share its cores.\n"
              f"          If fps is too low, give each laptop one camera via "
              f"IBVAP_WORKER_CAMERAS\n"
              f"          rather than lowering accuracy first.")

    boxes = BoxChannel(settings.boxes_bind, settings.boxes_port).start()

    workers = [
        CameraWorker(camera, settings, boxes, run_id, post=not args.no_backend,
                     detect_faces=not args.no_face, face_every=args.face_every)
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
    print(f"[people_service] running{f' for {args.seconds}s' if deadline else ''}. "
          f"ctrl-c to stop.\n")
    try:
        while not stopping.is_set():
            if not any(w.is_alive() for w in workers):
                print("[people_service] every worker exited")
                break
            if deadline and time.monotonic() >= deadline:
                print(f"[people_service] {args.seconds}s elapsed")
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
