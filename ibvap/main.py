"""
The vision service. One process, N cameras, one shared detection pass each,
many pluggable modules, two output channels.

    python main.py                          cameras from IBVAP_WORKER_CAMERAS
    python main.py --cameras cam_farm_gate
    python main.py --no-backend             live channel only, nothing recorded
    python main.py --seconds 60             stop and print comparable numbers

    RTSP ─> capture ─> ONE YOLO+ByteTrack pass ─> fence ──┐
                       (per camera)              anpr    ├─> live  WS  -> console
                                                 multi_human ─┘   ephemeral
                                                          └─> durable HTTP -> node
                                                                 confirmed only

WHAT THIS PROCESS OWNS: realtime observation. What it does NOT own: durable
truth and operator decisions. It never writes a database, never learns that an
operator acknowledged anything, and never receives a command. A confirmed
intrusion leaves here as a fact and comes back to the console as a record —
from the node, on the node's own channel. That round trip is the point: the
console treats the node, not a message from here, as authoritative for anything
that has to still be true tomorrow.

ASYNCIO, WITH THE TRADEOFF STATED OUT LOUD:
one task per camera, and the CPU-bound work (decode is already on its own
thread; inference and the modules) is pushed through asyncio.to_thread so the
loop is never held by a YOLO call. That is enough while the GIL is released
inside ultralytics/OpenCV native code, which is where nearly all of the time
goes. It is NOT enough if many cameras run on one box: threads then contend for
the same cores and each camera's rate falls roughly in proportion. The answer
at that point is a process per camera (multiprocessing), not a bigger thread
pool — and the honest first answer is the one this repo already uses: one
worker per laptop, IBVAP_WORKER_CAMERAS. Measure before assuming either; this
file prints the numbers you need at exit.

STATUS: prototype.
"""

import argparse
import asyncio
import os
import signal
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from config import (  # noqa: E402
    CameraConfig, Settings, cache_zones, cached_zones, fetch_zones, load_cameras,
)
from core.capture import RTSPStream  # noqa: E402
from core.detection import SharedDetector  # noqa: E402
from core.clip import ClipRecorder  # noqa: E402
from core.dispatcher import ClipSink, Dispatcher, DurableSink, LiveChannel  # noqa: E402
from modules.base import FrameContext, build  # noqa: E402

# Importing a module registers it. A new capability is a new file here plus a
# name in cameras.yml — the dispatch layer below never learns it exists.
import modules.anpr  # noqa: E402,F401
import modules.face  # noqa: E402,F401
import modules.fence  # noqa: E402,F401
import modules.multi_human  # noqa: E402,F401


def _clip_boxes(detections: list[dict]) -> list[dict]:
    """
    The boxes worth storing beside a clip frame.

    Trimmed to four fields rather than kept whole: a detection carries the
    tracker's internals and the raw COCO ids, and a clip is evidence an
    operator looks at, not a debug dump. Normalised `[x1,y1,x2,y2]` because
    that is what the console's overlay already draws (see `lib/live.ts`).
    """
    out = []
    for detection in detections:
        box = detection.get("bbox")
        if not box:
            continue
        out.append({
            "class": detection.get("class"),
            "confidence": round(float(detection.get("confidence") or 0.0), 3),
            "bbox": [round(float(v), 4) for v in box],
            "track_ref": detection.get("track_ref"),
        })
    return out


class CameraWorker:
    """One camera: one capture thread, one detector, its configured modules."""

    def __init__(self, camera: CameraConfig, settings: Settings,
                 dispatcher: Dispatcher, run_id: str):
        self.camera = camera
        self.settings = settings
        self.dispatcher = dispatcher
        self.run_id = run_id

        self.reader: RTSPStream | None = None
        self.detector: SharedDetector | None = None
        # `face` gets its weights path from Settings, same as the shared
        # detector's own `weights` -- unless a camera's own `face: {model:
        # ...}` already says so, which wins.
        self.modules = [
            build(name, camera.id,
                 {**params, "model": settings.face_model}
                 if name == "face" and "model" not in params else params)
            for name, params in camera.modules.items()
        ]

        self.frames = 0
        self.started_at = 0.0
        self._status = "UNKNOWN"

        # Evidence frames, opt-in per camera (`fence: { clips: true }` in
        # media/cameras.yml). Off unless asked for: the ring costs real RAM and
        # a post with ten cameras on one laptop should not pay for it on all
        # ten to get it on the gate. See core/clip.py for the memory arithmetic.
        fence_params = camera.module_params("fence")
        self.clips: ClipRecorder | None = (
            ClipRecorder(
                pre_seconds=float(fence_params.get("clip_pre_seconds", 4.0)),
                post_seconds=float(fence_params.get("clip_post_seconds", 2.0)),
                fps_hint=settings.target_fps,
            )
            if fence_params.get("clips")
            else None
        )

    def reconfigure(self, zones: list[dict]) -> None:
        """Re-apply operator-edited zones to the fence module, in place.

        The `params["zones"] = zones` below is an UNCONDITIONAL overwrite, and
        that is the point: it is what makes "the node is the only writer of
        geometry" true, so an operator's edit reaches the detector judging it
        within one refresh interval and nothing local can outvote it.

        A corollary worth knowing before you try it: a default zone written
        into media/cameras.yml would survive exactly zero frames. It is read at
        construction, then this line replaces it — and amain() blocks on the
        first refresh before the first frame is ever read. The fallback for a
        camera with no drawn area is the node's own labelled placeholder, not a
        local file. See fetch_zones in config.py.
        """
        for module in self.modules:
            if module.name != "fence":
                continue
            params = dict(self.camera.module_params("fence"))
            params["zones"] = zones
            module.configure(params)

    async def run(self, stop: asyncio.Event) -> None:
        camera = self.camera
        names = ", ".join(m.name for m in self.modules) or "none"
        print(f"[{camera.id}] {camera.rtsp_url}  modules: {names}"
              f"{'  (flagged simulated)' if camera.simulated else ''}")

        # drop=True: this is a live source. If inference is slower than the
        # stream — at a capped cadence it always is — the decoder buffer grows
        # and a "live" feed silently goes stale. See core/capture.py.
        self.reader = RTSPStream(camera.rtsp_url, name=camera.id, drop=True).start()
        self.detector = SharedDetector(
            weights=self.settings.weights,
            imgsz=self.settings.imgsz,
            conf=self.settings.conf,
            run_id=self.run_id,
        )

        interval = 1.0 / max(self.settings.target_fps, 30)
        self.started_at = time.monotonic()
        frame_index = 0
        next_tick = time.monotonic()

        try:
            while not stop.is_set():
                now = time.monotonic()
                if now < next_tick:
                    await asyncio.sleep(min(next_tick - now, 0.05))
                    continue
                # Pace from the deadline, not from "now + interval", so a slow
                # frame does not permanently push the cadence later.
                next_tick = max(now, next_tick + interval)

                self._health(now)

                _, frame = self.reader.read()
                if frame is None:
                    await asyncio.sleep(0.005)
                    continue

                frame_index += 1
                self.frames += 1

                # Arrival time, not true capture time — the difference is decode
                # and hand-off, which drop=True keeps bounded. Monotonic on
                # purpose: it cannot step backwards when the host clock is
                # corrected, and every confirm window is measured by
                # differencing these.
                ts = time.monotonic()
                height, width = frame.shape[:2]
                ctx = FrameContext(camera_id=camera.id, ts=ts, width=width,
                                   height=height, frame_index=frame_index)

                results = await asyncio.to_thread(self._infer, frame, ctx)

                for module_name, live_items, durable_items in results:
                    self.dispatcher.dispatch(
                        camera.id, module_name, ts,
                        live_items, durable_items, camera.simulated)

                # Clips whose post-roll has elapsed. Cheap when none are ready,
                # which is almost always -- it walks a list that is usually
                # empty. Encoding happens inside `collect`, off the event loop
                # only in the sense that this whole block runs between frames;
                # at one clip per crossing that is the right trade against the
                # complexity of another thread.
                self._drain_clips()
        finally:
            if self.reader:
                self.reader.stop()
            # A clip half-collected when the process stops is still evidence of
            # something that happened. Drained rather than discarded, for the
            # same reason DurableSink drains its queue on shutdown.
            self._drain_clips(force=True)

    def _drain_clips(self, force: bool = False) -> None:
        if self.clips is None:
            return
        sink = getattr(self.dispatcher, "clips", None)
        for clip in self.clips.collect(force=force):
            if sink is None:
                continue
            sink.submit_clip(self.camera.id, clip, self.camera.simulated)

    def _infer(self, frame, ctx: FrameContext):
        """
        The whole CPU-bound part of a frame, in one worker thread.

        Detection and every module run back to back here because they are
        sequential CPU work on the same pixels — hopping threads between them
        would buy nothing and cost a context switch per module per frame.
        """
        detections = self.detector.detect(frame)

        # Into the ring BEFORE the modules run. They receive the same array and
        # nothing forbids one of them drawing on it, so buffering afterwards
        # would record whatever the last module left behind rather than what the
        # detector judged. (`ClipRecorder.add` copies, so this is belt and
        # braces -- but the ordering is the part that would be silently wrong.)
        if self.clips is not None:
            self.clips.add(ctx.ts, frame, _clip_boxes(detections))

        results = []
        for module in self.modules:
            try:
                live_items, durable_items = module.process(frame, detections, ctx)
            except Exception as error:  # noqa: BLE001
                # One broken module must not take the camera down with it. The
                # others keep running and the failure is named, not swallowed.
                print(f"[{ctx.camera_id}/{module.name}] {type(error).__name__}: {error}")
                continue
            results.append((module.name, live_items, durable_items))

        if self.clips is not None:
            self._open_clips(results, ctx)
        return results

    def _open_clips(self, results, ctx: FrameContext) -> None:
        """
        Start a clip for every crossing that just confirmed.

        WHY THE POLICY LIVES HERE AND NOT IN `modules/fence.py`. Section 9: a
        module returns `(live, durable)` and names no transport. Deciding that
        an event is worth keeping frames for, and owning the frames to keep, is
        this file's job -- the module would otherwise need a reference to a
        recorder, which is a transport by another name.

        The id is minted now and written into the event that is about to be
        sent, so the link between an incident and its frames exists at the
        moment of emission. It does not depend on the node answering, on
        reading an HTTP response, or on the clip ever arriving -- an incident
        whose clip was shed still says which clip it was waiting for.

        CONFIRMED CROSSINGS ONLY. A track lost before confirmation already
        carries a thumbnail from the moment it crossed, and cutting a clip for
        every flicker would empty the ring onto the disk.
        """
        for _, _, durable_items in results:
            for event in durable_items:
                if event.get("event_type") != "intrusion":
                    continue
                data = event.get("data") or {}
                if data.get("rule") != "zone.crossing.confirmed":
                    continue
                clip_id = self.clips.next_id(self.run_id, ctx.camera_id)
                data["clip_id"] = clip_id
                event["data"] = data
                self.clips.start(clip_id, ctx.ts)

    def _health(self, now: float) -> None:
        """
        Camera status, observed rather than declared.

        The node's `camera.status` column is documented as written by the
        analysis engine from what it can actually see — this is that writer. A
        durable event is emitted on TRANSITION only: a camera that is fine does
        not need to say so sixty times a minute, and a camera that died needs
        to say so exactly once.
        """
        if not self.reader:
            return
        status = "FULL" if self.reader.healthy else "DEAD"
        if status == self._status:
            return
        was, self._status = self._status, status
        if was == "UNKNOWN" and status == "FULL":
            return  # starting up is not a state change worth recording
        self.dispatcher.dispatch(
            self.camera.id, "system", now, [],
            [{
                "event_type": "camera_health",
                "track_id": None,
                "data": {
                    "status": status,
                    "previous": was,
                    "reconnects": self.reader.reconnects,
                    "detail": "no frame within 5s" if status == "DEAD" else "frames resumed",
                },
            }],
            self.camera.simulated,
        )

    def snapshot(self) -> dict:
        """
        What this worker is doing right now, for the console's status card.

        Deliberately the SAME numbers the run summary prints at exit -- a
        console that reported different figures from the ones quoted in the
        measurements would make both untrustworthy.
        """
        elapsed = (time.monotonic() - self.started_at) if self.started_at else 0.0
        source = self.reader.stats() if self.reader else {}
        return {
            "camera_id": self.camera.id,
            "modules": [m.name for m in self.modules],
            "simulated": self.camera.simulated,
            "feed": "live" if (self.reader and self.reader.healthy) else "down",
            "frames": self.frames,
            "fps": round(self.frames / elapsed, 2) if elapsed else 0.0,
            "detector_ms": round(self.detector.mean_ms, 1) if self.detector else 0.0,
            "detector_calls": self.detector.calls if self.detector else 0,
            "drop_rate": source.get("drop_rate"),
            "reconnects": source.get("reconnects"),
        }

    def report(self) -> dict:
        elapsed = (time.monotonic() - self.started_at) if self.started_at else 0.0
        source = self.reader.stats() if self.reader else {}
        return {
            "camera": self.camera.id,
            "frames": self.frames,
            "fps": round(self.frames / elapsed, 2) if elapsed else 0.0,
            "detector_calls": self.detector.calls if self.detector else 0,
            "detector_ms": round(self.detector.mean_ms, 1) if self.detector else 0.0,
            "src_drop_rate": source.get("drop_rate"),
            "reconnects": source.get("reconnects"),
            "modules": {m.name: m.stats() for m in self.modules},
        }


async def refresh_zones(settings: Settings, workers: list[CameraWorker],
                        stop: asyncio.Event, first: asyncio.Event) -> None:
    """
    Keep the fence modules in step with what the operator has drawn.

    Polling rather than a push: this service must start and keep running when
    the node is down, and a poll degrades to "no zones yet" on its own. A push
    would need this process to hold a connection it cannot guarantee, for
    config it can survive without.
    """
    warned = False
    started = False
    while not stop.is_set():
        try:
            zones = await asyncio.to_thread(fetch_zones, settings)
            for worker in workers:
                worker.reconfigure(zones.get(worker.camera.id, []))
            await asyncio.to_thread(cache_zones, settings, zones)
            started = True
            if warned:
                print("[zones] edge node reachable again; zones re-applied")
                warned = False
        except Exception as error:  # noqa: BLE001
            if not warned:
                print(f"[zones] cannot read {settings.backend_url}/api/config: {error}")
                warned = True
            # The cache is a STARTUP fallback and nothing else. Mid-run, the
            # modules already hold live zones, which are by definition fresher
            # than anything on disk — so a later outage must change nothing.
            if not started:
                started = True
                restored = await asyncio.to_thread(cached_zones, settings)
                if restored is None:
                    print("        no cached zones either; fence modules run with "
                          "none until the node returns.")
                else:
                    cached, cached_at = restored
                    for worker in workers:
                        worker.reconfigure(cached.get(worker.camera.id, []))
                    age_minutes = (time.time() - cached_at) / 60.0
                    print(f"        judging from zones cached {age_minutes:.0f} min ago, "
                          f"marked STALE. Their crossings are recorded and never "
                          f"alerted: the operator may have moved a shape while the "
                          f"node was away, and nothing here can know.")
        finally:
            first.set()
        try:
            await asyncio.wait_for(stop.wait(), timeout=settings.zone_refresh_seconds)
        except asyncio.TimeoutError:
            pass


async def broadcast_status(live: LiveChannel, durable: "DurableSink | None",
                           workers: list[CameraWorker], run_id: str,
                           started: float, stop: asyncio.Event,
                           clips: "ClipSink | None",
                           every: float = 2.0) -> None:
    """
    Say out loud that this process is alive, and what it is managing.

    WHY A HEARTBEAT AND NOT SILENCE: observations only arrive when a camera is
    producing frames, so a console cannot tell a detector that crashed from a
    border where nothing is moving. Both look like an empty screen. This is the
    one message that separates them, which is why it rides its own queue and is
    never dropped in favour of a box.

    It carries the real numbers rather than a bare "ok" -- an operator who can
    see fps and detector milliseconds can tell a healthy service from one that
    is technically running at one frame every four seconds.
    """
    while not stop.is_set():
        live.broadcast({
            "kind": "status",
            "t": "status",
            "run_id": run_id,
            "uptime_s": round(time.monotonic() - started, 1),
            "cameras": [worker.snapshot() for worker in workers],
            "durable": durable.stats() if durable else None,
            "clips": clips.stats() if clips else None,
        })
        try:
            await asyncio.wait_for(stop.wait(), timeout=every)
        except asyncio.TimeoutError:
            pass


def print_report(workers: list[CameraWorker], live: LiveChannel,
                 durable: DurableSink | None, elapsed: float) -> None:
    print("\n--- RUN SUMMARY (measured on this machine, this run) ---")
    print(f"wall time : {elapsed:.1f}s")
    header = (f"{'camera':<18}{'fps':>7}{'det ms':>9}{'calls':>8}{'drop':>7}{'recon':>7}")
    print(header)
    print("-" * len(header))
    for worker in workers:
        r = worker.report()
        drop = r["src_drop_rate"]
        print(f"{r['camera']:<18}{r['fps']:>7.2f}{r['detector_ms']:>9.1f}"
              f"{r['detector_calls']:>8}"
              f"{(f'{drop * 100:.0f}%' if drop is not None else '-'):>7}"
              f"{str(r['reconnects'] or 0):>7}")
        for name, stats in r["modules"].items():
            if stats:
                detail = "  ".join(f"{k}={v}" for k, v in stats.items())
                print(f"  {name:<16}{detail}")

    print(f"\nlive channel   : {live.stats()}")
    print(f"durable sink   : {durable.stats() if durable else 'disabled'}")
    print("\nThese are the only performance figures you may quote.")


async def amain(args) -> None:
    settings = Settings()
    cameras = load_cameras(settings)
    if not cameras:
        raise SystemExit(
            "[vision] no cameras to run.\n"
            "         Every camera in media/cameras.yml has detect: false, or\n"
            "         IBVAP_WORKER_CAMERAS names none of them."
        )

    # Short and per-process: it scopes every track_ref this run emits, so a
    # restart cannot collide with ids the previous run left in the node.
    run_id = uuid.uuid4().hex[:4]

    print(f"[vision] run {run_id} - {len(cameras)} camera(s)")
    print(f"[vision] media   {settings.media_host}:{settings.rtsp_port}")
    print(f"[vision] node    {settings.backend_url}"
          f"{'  (disabled)' if args.no_backend else ''}")
    print(f"[vision] budget  imgsz={settings.imgsz} target_fps={settings.target_fps} "
          f"conf={settings.conf}")
    if len(cameras) > 1:
        print(f"[vision] NOTE: {len(cameras)} cameras on one box share its cores.\n"
              f"         If fps is too low, give each laptop one camera via\n"
              f"         IBVAP_WORKER_CAMERAS before lowering accuracy.")

    live = LiveChannel(settings.live_bind, settings.live_port)
    durable = None if args.no_backend else DurableSink(
        settings.backend_url, source_id=f"vision.{run_id}")

    # Only built when at least one camera asked for clips, so a deployment that
    # never enables them never opens the queue or the socket.
    wants_clips = any(camera.module_params("fence").get("clips") for camera in cameras)
    clips = None if (args.no_backend or not wants_clips) else ClipSink(
        settings.backend_url, source_id=f"vision.{run_id}")

    dispatcher = Dispatcher(live, durable)
    # Attached rather than passed through the constructor: Dispatcher's job is
    # the two contracts in section 14, and a clip is neither of them -- it is an
    # attachment to an event that has already gone. Keeping it off the
    # constructor keeps that separation legible.
    dispatcher.clips = clips

    workers = [CameraWorker(camera, settings, dispatcher, run_id) for camera in cameras]

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()

    def request_stop() -> None:
        stop.set()

    for name in ("SIGINT", "SIGTERM"):
        sig = getattr(signal, name, None)
        if sig is None:
            continue
        try:
            loop.add_signal_handler(sig, request_stop)
        except (NotImplementedError, RuntimeError, ValueError):
            # Windows' ProactorEventLoop has no add_signal_handler. The plain
            # handler still fires, and KeyboardInterrupt is caught below.
            signal.signal(sig, lambda *_: request_stop())

    live_task = asyncio.create_task(live.serve_forever(stop), name="live")
    tasks = [live_task]

    # Do not start detection until the live channel owns its port.  Previously
    # a duplicate process could fail here in a background task but carry on
    # posting durable vehicle/plate events, so one physical vehicle was counted
    # twice while the UI still appeared connected to just one service.
    ready_task = asyncio.create_task(live.ready.wait(), name="live-ready")
    done, _ = await asyncio.wait(
        {live_task, ready_task}, return_when=asyncio.FIRST_COMPLETED)
    if live_task in done:
        ready_task.cancel()
        await live_task  # surface bind errors and terminate this process
        raise RuntimeError("live channel stopped during startup")
    ready_task.cancel()
    await asyncio.gather(ready_task, return_exceptions=True)
    if durable:
        tasks.append(asyncio.create_task(durable.run_forever(stop), name="durable"))
    if clips:
        # Named "durable" so the shutdown path drains it alongside the events: a
        # clip collected during the final frames is worth the extra moment.
        tasks.append(asyncio.create_task(clips.run_forever(stop), name="durable"))

    # Zones before the first frame: a fence that starts blind and learns its
    # geometry a few seconds later would silently miss the opening of a demo.
    zones_ready = asyncio.Event()
    tasks.append(asyncio.create_task(
        refresh_zones(settings, workers, stop, zones_ready), name="zones"))
    await zones_ready.wait()

    started = time.monotonic()
    camera_tasks = [asyncio.create_task(w.run(stop), name=w.camera.id) for w in workers]
    tasks.append(asyncio.create_task(
        broadcast_status(live, durable, workers, run_id, started, stop, clips), name="status"))

    if args.seconds:
        print(f"[vision] running for {args.seconds}s. ctrl-c to stop early.\n")
        try:
            await asyncio.wait_for(stop.wait(), timeout=args.seconds)
        except asyncio.TimeoutError:
            print(f"[vision] {args.seconds}s elapsed")
            stop.set()
    else:
        print("[vision] running. ctrl-c to stop.\n")
        await stop.wait()

    await asyncio.gather(*camera_tasks, return_exceptions=True)
    # The live task is cancelled outright: its queues hold boxes, which are
    # worthless. The durable task is awaited so it can drain confirmed events
    # that have not been posted yet — the one thing here that must not be lost.
    for task in tasks:
        if task.get_name() != "durable":
            task.cancel()
    if durable:
        await asyncio.gather(*[t for t in tasks if t.get_name() == "durable"],
                             return_exceptions=True)
    await asyncio.gather(*tasks, return_exceptions=True)

    print_report(workers, live, durable, time.monotonic() - started)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    parser.add_argument("--cameras", help="comma-separated camera ids, overriding "
                                          "IBVAP_WORKER_CAMERAS")
    parser.add_argument("--no-backend", action="store_true",
                        help="skip the durable POST; live channel only")
    parser.add_argument("--imgsz", type=int, help="override IBVAP_IMGSZ")
    parser.add_argument("--target-fps", type=float, help="override IBVAP_TARGET_FPS")
    parser.add_argument("--seconds", type=int, default=0,
                        help="stop after N seconds and print the summary. This is "
                             "how you get comparable baseline numbers off each "
                             "team laptop: same clip, same flags, same duration.")
    args = parser.parse_args()

    if args.cameras:
        os.environ["IBVAP_WORKER_CAMERAS"] = args.cameras
    if args.imgsz:
        os.environ["IBVAP_IMGSZ"] = str(args.imgsz)
    if args.target_fps:
        os.environ["IBVAP_TARGET_FPS"] = str(args.target_fps)

    try:
        asyncio.run(amain(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
