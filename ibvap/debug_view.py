"""
Quick local-file test harness for one or more vision modules, without the
media hub or the edge node.

    python debug_view.py --source data/cam1.mp4 --show
    python debug_view.py --source data/cam1.mp4 --modules multi_human,face --show
    python debug_view.py --source rtsp://127.0.0.1:8554/cam1 --show

WHAT THIS IS FOR: main.py's pipeline pulls RTSP from the media hub and needs
the edge node up for zones and the durable sink -- the right shape for the
real pipeline, and the wrong one for "does this module work on this clip",
which needs no hub, no node, and an answer in one command. This script runs
the SAME SharedDetector and the SAME modules main.py does, directly against a
file, RTSP URL or webcam, drawn to a window instead of shipped over a
websocket.

WHAT THIS IS NOT: a replacement for main.py, and not what the demo runs on. It
never posts anywhere durable. A fence module here starts with no zones and
stays that way -- there is no node for it to read them from -- so it is only
useful for modules that do not need zones (multi_human, face; anpr needs
nothing but the clip either). It exists to answer one question, fast: is this
module doing the right thing on this footage.

STATUS: prototype. Debug tool, not part of the production pipeline.
"""

import argparse
import os
import sys
import time

import cv2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from core.capture import RTSPStream
from core.detection import SharedDetector
from modules.base import REGISTRY, FrameContext, build

# Importing a module registers it -- the same requirement main.py has.
import modules.anpr  # noqa: E402,F401
import modules.face  # noqa: E402,F401
import modules.fence  # noqa: E402,F401
import modules.multi_human  # noqa: E402,F401


def colour_for(key: str) -> tuple[int, int, int]:
    """Deterministic per-track colour, BGR -- same hash shape as the console's
    colourFor() in camera-feed.tsx, so a screenshot here and one from the
    browser read the same way."""
    h = 0
    for ch in key:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    hue = h % 180  # OpenCV hue range is 0-179
    bgr = cv2.cvtColor(
        __import__("numpy").uint8([[[hue, 200, 255]]]), cv2.COLOR_HSV2BGR)[0][0]
    return int(bgr[0]), int(bgr[1]), int(bgr[2])


def draw_label(frame, x, y, text, colour, fg=(15, 15, 15)):
    font = cv2.FONT_HERSHEY_SIMPLEX
    (tw, th), _ = cv2.getTextSize(text, font, 0.5, 1)
    cv2.rectangle(frame, (x, max(0, y - th - 6)), (x + tw + 6, y), colour, -1)
    cv2.putText(frame, text, (x + 3, max(th, y - 4)), font, 0.5, fg, 1, cv2.LINE_AA)


def draw(frame, per_module_tracks: dict[str, list[dict]], hud: list[str]):
    height, width = frame.shape[:2]
    for module_name, tracks in per_module_tracks.items():
        for track in tracks:
            x1, y1, x2, y2 = track["bbox"]
            px1, py1, px2, py2 = int(x1 * width), int(y1 * height), int(x2 * width), int(y2 * height)
            extra = track.get("extra") or {}
            # Prefer the stable multi_human identity over the raw track_ref,
            # so the same person keeps the same colour across a ByteTrack id
            # change instead of just across one track's lifetime.
            key = extra.get("person_id") or extra.get("track_ref") \
                or f'{module_name}:{track.get("track_id")}'
            colour = colour_for(key)

            cv2.rectangle(frame, (px1, py1), (px2, py2), colour, 2)
            label = extra.get("person_id") or f'{module_name}/{track["class"]}'
            draw_label(frame, px1, py1, f'{label} {track["confidence"]*100:.0f}%', colour)

            trail = extra.get("trail")
            if trail and len(trail) > 1:
                pts = [(int(px * width), int(py * height)) for px, py in trail]
                for a, b in zip(pts, pts[1:]):
                    cv2.line(frame, a, b, colour, 2)

            face = extra.get("face")
            if face:
                fx1, fy1, fx2, fy2 = face["bbox"]
                fp1 = (int(fx1 * width), int(fy1 * height))
                fp2 = (int(fx2 * width), int(fy2 * height))
                cv2.rectangle(frame, fp1, fp2, (94, 230, 163), 2)
                draw_label(frame, fp1[0], fp1[1], f'face {face["score"]*100:.0f}%', (94, 230, 163))

            plate = extra.get("plate")
            if plate:
                bx1, by1, bx2, by2 = plate["bbox"]
                bp1 = (int(bx1 * width), int(by1 * height))
                bp2 = (int(bx2 * width), int(by2 * height))
                cv2.rectangle(frame, bp1, bp2, (36, 191, 251), 2)
                draw_label(frame, bp1[0], bp1[1], plate["text"], (36, 191, 251))

    y = 22
    for line in hud:
        cv2.putText(frame, line, (10, y), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 3, cv2.LINE_AA)
        cv2.putText(frame, line, (10, y), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 1, cv2.LINE_AA)
        y += 24
    return frame


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--source", required=True,
                    help="file path, rtsp:// URL, or webcam index")
    ap.add_argument("--modules", default="multi_human",
                    help=f"comma-separated, from: {', '.join(sorted(REGISTRY) or ['(import modules first)'])}")
    ap.add_argument("--weights", default="yolo11n.pt")
    ap.add_argument("--imgsz", type=int, default=480)
    ap.add_argument("--conf", type=float, default=0.35)
    ap.add_argument("--face-model", default=None,
                    help="overrides the face module's default weights path")
    ap.add_argument("--show", action="store_true")
    ap.add_argument("--display-width", type=int, default=1280)
    ap.add_argument("--save", default=None)
    ap.add_argument("--max-frames", type=int, default=0)
    ap.add_argument("--loop", action="store_true",
                    help="restart a file at EOF instead of stopping")
    ap.add_argument("--dump-dir", default=None,
                    help="save an annotated PNG every time multi_human mints "
                         "a new identity -- for inspecting exactly what a "
                         "mint looked like without watching the whole clip")
    args = ap.parse_args()

    if args.dump_dir:
        os.makedirs(args.dump_dir, exist_ok=True)

    source = int(args.source) if args.source.isdigit() else args.source

    reader = RTSPStream(source, name="debug", loop=args.loop).start()
    detector = SharedDetector(weights=args.weights, imgsz=args.imgsz, conf=args.conf,
                              run_id="dbg")

    module_names = [m.strip() for m in args.modules.split(",") if m.strip()]
    module_params = {}
    if args.face_model:
        module_params["face"] = {"model": args.face_model}
    modules = [build(name, "debug", module_params.get(name, {})) for name in module_names]

    writer = None
    frame_idx = 0
    infer_seconds = 0.0
    infer_calls = 0
    t_start = time.time()
    per_module_tracks: dict[str, list[dict]] = {name: [] for name in module_names}
    multi_human_module = next((m for m in modules if m.name == "multi_human"), None)
    prev_identity_count = 0

    print(f"[debug] modules: {', '.join(module_names)}")
    print("[debug] running. 'q' in the window (or ctrl-c) to stop.\n")
    try:
        while True:
            fid, frame = reader.read()
            if frame is None:
                if reader.eof:
                    break
                if args.max_frames and frame_idx >= args.max_frames:
                    break
                time.sleep(0.002)
                continue

            frame_idx += 1
            height, width = frame.shape[:2]
            ctx = FrameContext(camera_id="debug", ts=time.monotonic(),
                               width=width, height=height, frame_index=frame_idx)

            t0 = time.time()
            detections = detector.detect(frame)
            for module in modules:
                live_items, _durable = module.process(frame, detections, ctx)
                per_module_tracks[module.name] = live_items
            infer_seconds += time.time() - t0
            infer_calls += 1

            elapsed = time.time() - t_start
            fps = frame_idx / elapsed if elapsed > 0 else 0
            avg_ms = (infer_seconds / infer_calls * 1000) if infer_calls else 0
            counts = "  ".join(f"{n}={len(t)}" for n, t in per_module_tracks.items())
            hud = [
                f"pipeline {fps:5.1f} FPS   pass+modules {avg_ms:5.1f} ms/call",
                counts,
            ]
            vis = draw(frame.copy(), per_module_tracks, hud)

            if args.dump_dir and multi_human_module is not None:
                count = len(multi_human_module._identities)
                if count > prev_identity_count:
                    path = os.path.join(args.dump_dir, f"frame{frame_idx:05d}_identities{count}.png")
                    cv2.imwrite(path, vis)
                prev_identity_count = count

            if args.save:
                if writer is None:
                    h, w = vis.shape[:2]
                    writer = cv2.VideoWriter(args.save, cv2.VideoWriter_fourcc(*"mp4v"), 20, (w, h))
                writer.write(vis)

            if args.show:
                show_frame = vis
                h, w = vis.shape[:2]
                if w > args.display_width:
                    scale = args.display_width / w
                    show_frame = cv2.resize(vis, (args.display_width, int(h * scale)))
                cv2.imshow("IBVAP debug", show_frame)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break

            if args.max_frames and frame_idx >= args.max_frames:
                break
    except KeyboardInterrupt:
        pass
    finally:
        reader.stop()
        if writer:
            writer.release()
        if args.show:
            cv2.destroyAllWindows()

    dur = time.time() - t_start
    print("\n--- RUN SUMMARY (measured on this machine, this run) ---")
    print(f"frames processed : {frame_idx}")
    print(f"wall time        : {dur:.1f}s")
    print(f"pipeline FPS     : {frame_idx/dur:.2f}" if dur else "")
    print(f"pass+modules ms  : {infer_seconds/infer_calls*1000:.1f}" if infer_calls else "")
    print(f"source stats     : {reader.stats()}")
    for module in modules:
        print(f"{module.name:<16} {module.stats()}")


if __name__ == "__main__":
    main()
