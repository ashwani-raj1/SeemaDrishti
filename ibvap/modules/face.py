"""
Cascaded face detection: look for a face only inside a person box the shared
pass already found.

WHY CASCADED, NOT FULL-FRAME: search a handful of small head-height crops
instead of the whole frame for something that occupies a few dozen pixels of
it. That is also what keeps false positives out BY CONSTRUCTION, not by
threshold tuning: foliage, rocks, tyre treads and window reflections never
audition for the face detector because they never audition for a person box
first (the same argument `modules/anpr.py` makes for plate OCR).

DETECTION ONLY. NEVER RECOGNITION, NEVER IDENTITY: YuNet
(`cv2.FaceDetectorYN`, ~230 KB ONNX) outputs a bounding box and a confidence
score. The five landmarks it also produces are used only to judge whether the
detection is a plausible face, never to compare one face with another. The
word "recognition" must never describe this module, in code, docs or a slide
-- see claude.md §8.

LIVE ONLY, ON PURPOSE: a face box is drawn on the console and nothing else.
This module emits nothing on the durable path. "A face was seen" with no
identity behind it and no watchlist to check it against is not evidence, it
is noise -- recording it durably would be inventing a capability (watchlist
matching) that does not exist yet, just because the precondition for it does.

CADENCE: a face does not need a per-frame update -- the subject's pose barely
changes between two detector calls at 6 fps. `face_every` (default: every
5th processed frame) is deliberately coarser than the shared pass, the same
reasoning `modules/multi_human.py` applies to `embed_every`. The most recent
detection per track is kept and redrawn on the frames in between, so the box
does not flicker at the cadence it is actually computed on.

STATUS: prototype. Detection only; nothing beyond it is implemented or implied.
"""

import os
from pathlib import Path
from typing import Any, Optional

from core.payload import live_track
from modules.base import FrameContext, VisionModule, register

#: Resolved against THIS directory, not the current one -- the identical
#: reason `config.py Settings.weights` resolves against `HERE`: a bare
#: relative path means "found" or "missing" depends on whether `main.py` was
#: launched from the repo root or from inside `ibvap/`, and that difference
#: looks like a broken model rather than a path bug. `IBVAP_FACE_MODEL` (via
#: `Settings.face_model`) overrides this per-machine; a camera's own
#: `face: {model: ...}` param overrides both.
DEFAULT_MODEL = str(Path(__file__).resolve().parent.parent / "data"
                    / "face_detection_yunet_2023mar.onnx")


class FaceDetector:
    """
    YuNet, loaded once per camera. Sized for a CPU box on purpose -- there is
    no larger variant worth trading accuracy up for here, the same argument
    claude.md §5 makes for YOLO11n over yolo11s/m/l.
    """

    def __init__(self, model_path: str, score_threshold=0.75, nms_threshold=0.3,
                top_k=5):
        self.model_path = model_path
        self.score_threshold = score_threshold
        self.nms_threshold = nms_threshold
        self.top_k = top_k
        self._detector = None
        self._size = (0, 0)

    def _ensure(self, size: tuple[int, int]):
        if self._detector is not None and self._size == size:
            return
        import cv2  # imported here, not at module scope: a fence-only or
                    # anpr-only camera should not pay this module's import
                    # cost, matching modules/anpr.py's lazy easyocr import.
        if not os.path.exists(self.model_path):
            raise FileNotFoundError(
                f"YuNet weights not found at {self.model_path}. Download the "
                f"~230 KB ONNX from opencv_zoo using GitHub's \"Download raw "
                f"file\" button -- a plain right-click-save yields a 131-byte "
                f"git-LFS pointer, not the model (claude.md §12.2)."
            )
        self._detector = cv2.FaceDetectorYN.create(
            self.model_path, "", size, self.score_threshold,
            self.nms_threshold, self.top_k,
        )
        self._size = size

    def detect(self, crop) -> list[dict]:
        height, width = crop.shape[:2]
        if height < 12 or width < 12:
            return []  # too few pixels to be a face rather than a smudge
        self._ensure((width, height))
        self._detector.setInputSize((width, height))
        _, faces = self._detector.detect(crop)
        if faces is None:
            return []
        out = []
        for face in faces:
            x, y, w, h, score = face[0], face[1], face[2], face[3], face[-1]
            out.append({"bbox_px": (int(x), int(y), int(x + w), int(y + h)),
                        "score": float(score)})
        return out


@register
class FaceModule(VisionModule):
    name = "face"

    def configure(self, params: dict[str, Any]) -> None:
        super().configure(params)
        self.face_every = max(1, int(params.get("face_every", 5)))
        # A head sits near the top of a standing, sitting or crouching
        # subject alike -- searching the whole body wastes exactly what this
        # cascade exists to save.
        self.upper_frac = float(params.get("upper_frac", 0.55))

        model_path = params.get("model") or DEFAULT_MODEL
        if not hasattr(self, "_detector") or model_path != getattr(self, "_model_path", None):
            self._model_path = model_path
            self._detector = FaceDetector(
                model_path,
                score_threshold=float(params.get("score_threshold", 0.75)),
            )
            self._disabled = False
            self._warned = False

        if not hasattr(self, "_best"):
            # Best face seen per track, redrawn between detector calls so the
            # box does not flicker at face_every's coarser cadence.
            self._best: dict[str, dict] = {}
            self.faces_seen = 0

    def process(self, frame, detections: list[dict], ctx: FrameContext):
        live: list[dict] = []
        durable: list[dict] = []  # detection only -- never anything durable

        people = [d for d in detections if d.get("is_person") and d.get("track_ref")]
        if not people or self._disabled:
            return live, durable

        run_now = ctx.frame_index % self.face_every == 0
        height, width = frame.shape[:2]

        for person in people:
            ref = person["track_ref"]
            if run_now:
                found = self._find_face(frame, person)
                if found:
                    self.faces_seen += 1
                    self._best[ref] = found

            extra: dict[str, Any] = {"track_ref": ref}
            best = self._best.get(ref)
            if best:
                fx1, fy1, fx2, fy2 = best["bbox_px"]
                extra["face"] = {
                    # Normalised [x1, y1, x2, y2] -- the same convention the
                    # top-level track box uses, so the console draws both with
                    # one code path instead of two conventions per module.
                    "bbox": [fx1 / width, fy1 / height, fx2 / width, fy2 / height],
                    "score": round(best["score"], 3),
                }
            live.append(live_track(person, extra))

        # Tracks that left frame keep no state here worth expiring on a timer
        # -- there is nothing to prune but this one dict entry, and multi_human
        # already owns telling a track's lifetime apart from a face's.
        seen = {p["track_ref"] for p in people}
        for ref in [r for r in self._best if r not in seen]:
            del self._best[ref]

        return live, durable

    def _find_face(self, frame, person) -> Optional[dict]:
        x1, y1, x2, y2 = person["bbox_px"]
        y_cut = y1 + int((y2 - y1) * self.upper_frac)
        crop = frame[y1:y_cut, x1:x2]
        if crop.size == 0:
            return None
        try:
            faces = self._detector.detect(crop)
        except FileNotFoundError as error:
            if not self._warned:
                print(f"[face] {error}")
                self._warned = True
            self._disabled = True
            return None
        if not faces:
            return None
        best = max(faces, key=lambda f: f["score"])
        fx1, fy1, fx2, fy2 = best["bbox_px"]
        # Back to full-frame pixels: the crop was offset by (x1, y1).
        return {"bbox_px": (x1 + fx1, y1 + fy1, x1 + fx2, y1 + fy2),
                "score": best["score"]}

    def stats(self) -> dict:
        return {"tracked_faces": len(self._best), "faces_seen": self.faces_seen}
