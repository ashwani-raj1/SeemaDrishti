"""
Cascaded face detection.

THE CORE IDEA (this is your best technical talking point for these two
features): do NOT run a face detector over the full frame. Run it only inside
the upper portion of each already-tracked person box.

Why this is genuinely better, not just faster:
  * COMPUTE. A 1920x1080 frame is ~2.07M pixels. A person box at a realistic
    surveillance distance is maybe 80x200 px; its head region ~80x70. Searching
    a handful of small crops instead of the whole frame is a large reduction.
    (Exact speedup depends on person count -- MEASURE IT, do not quote a number
    you have not produced. See benchmark.py.)
  * FALSE POSITIVES. Face detectors hallucinate on foliage, rocks, tyre treads,
    window reflections -- all of which a border scene is full of. Constraining
    the search to person regions removes that entire error class by construction.
  * ATTRIBUTION. A full-frame detector gives you a floating face box. This gives
    you face -> person -> track_id, so every face is already bound to a tracked
    identity. That is the precondition for watchlist matching later: you match
    once per track, not once per frame.

MODEL: YuNet (cv2.FaceDetectorYN). ~230KB ONNX, built for CPU.
Not MTCNN (three-stage, slow), not RetinaFace-R50 (too heavy without a GPU).

HONEST LIMITATION: YuNet is a DETECTOR. It outputs a box and 5 landmarks.
It does NOT identify anyone. Recognition/watchlist is a separate embedding
model and is NOT implemented here. Do not let anyone on your team put the word
"recognition" on a slide describing this file.

STATUS: prototype.
"""

import os
import cv2
import numpy as np

YUNET_URL = ("https://github.com/opencv/opencv_zoo/blob/main/models/"
             "face_detection_yunet/face_detection_yunet_2023mar.onnx")


class FaceDetector:
    def __init__(self, model_path="data/face_detection_yunet_2023mar.onnx",
                 conf=0.7, nms=0.3, top_k=50):
        if not os.path.exists(model_path) or os.path.getsize(model_path) < 10000:
            raise FileNotFoundError(
                f"YuNet weights missing or is a git-LFS pointer: {model_path}\n"
                f"Download the real file (~230KB) from:\n  {YUNET_URL}\n"
                f"Use the 'Download raw file' button -- a plain right-click save "
                f"gives you a 131-byte pointer, not the model."
            )
        # Input size is reset per crop before every detect() call.
        self.net = cv2.FaceDetectorYN.create(
            model=model_path, config="", input_size=(320, 320),
            score_threshold=conf, nms_threshold=nms, top_k=top_k,
        )

    @staticmethod
    def head_region(bbox, frame_shape, head_frac=0.40, pad=0.15):
        """
        Upper slice of a person box, where a head can be.
        head_frac=0.40 is deliberately generous: people crouch, bend, and sit,
        and a tight 0.25 slice will miss them. Tune this on YOUR footage.
        """
        x1, y1, x2, y2 = bbox
        h = y2 - y1
        w = x2 - x1
        hy2 = y1 + int(h * head_frac)
        px = int(w * pad)
        py = int(h * pad * 0.5)

        H, W = frame_shape[:2]
        rx1 = max(0, x1 - px)
        ry1 = max(0, y1 - py)
        rx2 = min(W, x2 + px)
        ry2 = min(H, hy2 + py)
        return rx1, ry1, rx2, ry2

    def detect_in_crop(self, crop):
        """Return list of (x, y, w, h, score) in CROP coordinates."""
        h, w = crop.shape[:2]
        if h < 20 or w < 20:
            return []
        self.net.setInputSize((w, h))
        _, faces = self.net.detect(crop)
        if faces is None:
            return []
        out = []
        for f in faces:
            x, y, fw, fh = f[0:4]
            score = float(f[-1])
            out.append((int(x), int(y), int(fw), int(fh), score))
        return out

    def detect_for_persons(self, frame, persons, min_person_h=60):
        """
        persons: output of PersonTracker.update()
        Returns list of dicts: {track_id, face_bbox (frame coords), score}

        min_person_h: skip people too small for a face to be resolvable.
        A 40px-tall person has a ~10px head. No detector will find that, and
        pretending otherwise is how you get a demo that mysteriously "misses".
        """
        results = []
        for p in persons:
            x1, y1, x2, y2 = p["bbox"]
            if (y2 - y1) < min_person_h:
                continue

            rx1, ry1, rx2, ry2 = self.head_region(p["bbox"], frame.shape)
            crop = frame[ry1:ry2, rx1:rx2]
            if crop.size == 0:
                continue

            for (fx, fy, fw, fh, score) in self.detect_in_crop(crop):
                results.append({
                    "track_id": p["track_id"],
                    "face_bbox": (rx1 + fx, ry1 + fy,
                                  rx1 + fx + fw, ry1 + fy + fh),
                    "score": score,
                })
        return results


class BestFacePerTrack:
    """
    Keep only the single highest-quality face crop per track id.

    Why: an operator does not want 400 face thumbnails of the same person.
    They want ONE good one. This is also what a watchlist matcher should
    consume -- match once per track, not once per frame. Directly attacks
    operator alert fatigue, which is a real deployment failure mode.

    Quality proxy = detector score * face area. Crude but it works; a stronger
    version would add a blur metric (variance of Laplacian). NOT MEASURED YET.
    """

    def __init__(self):
        self.best = {}  # track_id -> {"quality":float, "crop":ndarray, "score":float}

    def update(self, frame, faces):
        for f in faces:
            tid = f["track_id"]
            if tid is None:
                continue
            x1, y1, x2, y2 = f["face_bbox"]
            crop = frame[max(0, y1):y2, max(0, x1):x2]
            if crop.size == 0:
                continue
            area = (x2 - x1) * (y2 - y1)
            quality = f["score"] * float(area)
            prev = self.best.get(tid)
            if prev is None or quality > prev["quality"]:
                self.best[tid] = {"quality": quality,
                                  "crop": crop.copy(),
                                  "score": f["score"]}

    def save_all(self, outdir="data/faces"):
        os.makedirs(outdir, exist_ok=True)
        paths = []
        for tid, rec in self.best.items():
            path = os.path.join(outdir, f"track_{tid}.jpg")
            cv2.imwrite(path, rec["crop"])
            paths.append(path)
        return paths
