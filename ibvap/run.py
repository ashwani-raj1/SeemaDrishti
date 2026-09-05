"""
IBVAP -- person tracking + cascaded face detection.

Usage:
    python run.py --source data/test.mp4 --show
    python run.py --source rtsp://127.0.0.1:8554/cam1 --save out.mp4
    python run.py --source 0 --show                     # webcam

CPU BUDGET CONTROL:
    --detect-every N   run the detector on every Nth frame only.
                       N=1 is most accurate and slowest.
                       N=2/3 roughly halves/thirds detector cost.
    --face-every N     run face detection on every Nth frame.
                       Faces do not need per-frame updates; you only need ONE
                       good crop per track, so this can be much coarser (5-10).

STATUS: prototype/demo harness. Not production. No API, no persistence,
single camera, no auth.
"""

import argparse
import time
import sys
import os

import cv2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from core.ingest import StreamReader
from core.person import PersonTracker, TrackHistory
from core.face import FaceDetector, BestFacePerTrack
from core.ingress_client import IngressClient


def color_for(tid):
    if tid is None:
        return (128, 128, 128)
    import random
    random.seed(tid * 9973)
    return tuple(random.randint(60, 255) for _ in range(3))


def draw(frame, persons, faces, history, hud):
    for p in persons:
        x1, y1, x2, y2 = p["bbox"]
        tid = p["track_id"]
        c = color_for(tid)
        cv2.rectangle(frame, (x1, y1), (x2, y2), c, 2)
        label = f"ID {tid}" if tid is not None else "person"
        cv2.putText(frame, f"{label} {p['conf']:.2f}", (x1, max(14, y1 - 6)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, c, 2)

        trail = history.trails.get(tid, [])
        for i in range(1, len(trail)):
            cv2.line(frame, trail[i - 1], trail[i], c, 2)

    for f in faces:
        fx1, fy1, fx2, fy2 = f["face_bbox"]
        cv2.rectangle(frame, (fx1, fy1), (fx2, fy2), (0, 255, 255), 2)
        cv2.putText(frame, f"face {f['score']:.2f}", (fx1, max(12, fy1 - 4)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 255, 255), 1)

    y = 22
    for line in hud:
        cv2.putText(frame, line, (10, y), cv2.FONT_HERSHEY_SIMPLEX,
                    0.6, (0, 0, 0), 3)
        cv2.putText(frame, line, (10, y), cv2.FONT_HERSHEY_SIMPLEX,
                    0.6, (0, 255, 0), 1)
        y += 24
    return frame


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True)
    ap.add_argument("--weights", default="yolo11n.pt")
    ap.add_argument("--face-model",
                    default="data/face_detection_yunet_2023mar.onnx")
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--conf", type=float, default=0.35)
    ap.add_argument("--detect-every", type=int, default=1)
    ap.add_argument("--face-every", type=int, default=5)
    ap.add_argument("--no-face", action="store_true")
    ap.add_argument("--show", action="store_true")
    ap.add_argument("--display-width", type=int, default=1280,
                     help="scale the --show window to fit this width; "
                          "does not affect inference res (--imgsz) or --save")
    ap.add_argument("--save", default=None)
    ap.add_argument("--max-frames", type=int, default=0)
    ap.add_argument("--trail-len", type=int, default=0,
                     help="max points kept per movement trail; 0 = unlimited "
                          "(fine for a bounded demo clip -- set a finite value "
                          "for a long-running live/RTSP source)")
    ap.add_argument("--post-url", default=None,
                     help="backend base URL (e.g. http://localhost:8000) -- "
                          "when set, posts person detections to its "
                          "/hooks/ingress/detections seam every detector call. "
                          "Off by default; the demo runs standalone otherwise.")
    ap.add_argument("--camera-id", default="cam_fence_north",
                     help="must match a camera already seeded in the backend "
                          "db (see backend/src/db/seed.ts); the backend "
                          "rejects frames for an unknown camera_id")
    ap.add_argument("--loop", action="store_true",
                    help="restart a file source at EOF (demo convenience)")
    args = ap.parse_args()

    source = int(args.source) if args.source.isdigit() else args.source

    reader = StreamReader(source, name="cam1", loop=args.loop).start()
    tracker = PersonTracker(weights=args.weights, imgsz=args.imgsz,
                            conf=args.conf)
    history = TrackHistory(max_len=args.trail_len or None)

    face_det = None
    best_faces = BestFacePerTrack()
    if not args.no_face:
        try:
            face_det = FaceDetector(args.face_model)
        except FileNotFoundError as e:
            print(f"[warn] face stage disabled:\n{e}\n")

    ingress = IngressClient(args.post_url, args.camera_id) if args.post_url else None

    writer = None
    frame_idx = 0
    persons, faces = [], []
    t_start = time.time()
    infer_time_total = 0.0
    infer_calls = 0

    print("[info] running. ctrl-c to stop.")
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

            if frame_idx % args.detect_every == 0:
                t0 = time.time()
                persons = tracker.update(frame)
                infer_time_total += time.time() - t0
                infer_calls += 1
                history.update(persons, frame_idx)
                if ingress:
                    ingress.send(persons, frame.shape)

            if face_det and persons and frame_idx % args.face_every == 0:
                faces = face_det.detect_for_persons(frame, persons)
                best_faces.update(frame, faces)
            elif frame_idx % args.face_every != 0:
                pass  # keep last drawn faces

            elapsed = time.time() - t_start
            fps = frame_idx / elapsed if elapsed > 0 else 0
            avg_infer = (infer_time_total / infer_calls * 1000) if infer_calls else 0
            st = reader.stats()
            hud = [
                f"pipeline {fps:5.1f} FPS   detector {avg_infer:5.1f} ms/call",
                f"persons {len(persons)}  tracks {len(history.trails)}  "
                f"faces(last) {len(faces)}",
                f"src drop {st['drop_rate']*100:.1f}%  reconnects {st['reconnects']}",
            ]
            vis = draw(frame.copy(), persons, faces, history, hud)

            if args.save:
                if writer is None:
                    h, w = vis.shape[:2]
                    writer = cv2.VideoWriter(
                        args.save, cv2.VideoWriter_fourcc(*"mp4v"), 20, (w, h))
                writer.write(vis)

            if args.show:
                show_frame = vis
                h, w = vis.shape[:2]
                if w > args.display_width:
                    scale = args.display_width / w
                    show_frame = cv2.resize(
                        vis, (args.display_width, int(h * scale)))
                cv2.imshow("IBVAP", show_frame)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break

            if args.max_frames and frame_idx >= args.max_frames:
                break
    except KeyboardInterrupt:
        pass
    finally:
        reader.stop()
        if ingress:
            ingress.stop()
        if writer:
            writer.release()
        if args.show:
            cv2.destroyAllWindows()

    saved = best_faces.save_all()
    dur = time.time() - t_start
    print("\n--- RUN SUMMARY (these are your real numbers) ---")
    print(f"frames processed : {frame_idx}")
    print(f"wall time        : {dur:.1f}s")
    print(f"pipeline FPS     : {frame_idx/dur:.2f}" if dur else "")
    print(f"detector ms/call : "
          f"{infer_time_total/infer_calls*1000:.1f}" if infer_calls else "")
    print(f"unique track ids : {len(history.trails)}")
    print(f"face crops saved : {len(saved)}")
    print(f"source stats     : {reader.stats()}")
    if ingress:
        print(f"backend ingress  : {ingress.sent} sent, {ingress.failed} failed "
              f"-> {ingress.url} (camera_id={ingress.camera_id})")


if __name__ == "__main__":
    main()
