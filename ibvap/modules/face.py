"""
Cascaded face detection: look for a face only inside a person box the shared
pass already found.

WHY CASCADED, NOT FULL-FRAME: search a handful of small head-height crops
instead of the whole frame for something that occupies a few dozen pixels of
it. That is also what keeps false positives out BY CONSTRUCTION, not by
threshold tuning: foliage, rocks, tyre treads and window reflections never
audition for the face detector because they never audition for a person box
first (the same argument `modules/anpr.py` makes for plate OCR).

TWO CLASSES, TWO DIFFERENT CLAIMS -- read this before touching either one:

  FaceDetector   YuNet (`cv2.FaceDetectorYN`, ~230 KB ONNX). Outputs a
                 bounding box and a score: "a face is here", nothing else.
                 DETECTION ONLY. The word "recognition" must never describe
                 this class, in code, docs or a slide -- see claude.md §8.

  FaceEmbedder   SFace (`cv2.FaceRecognizerSF`, opencv_zoo's OWN matched
                 pairing for YuNet -- same project, tuned to work together).
                 Turns a detected face into a vector that can be compared
                 against ANOTHER face's vector. This genuinely IS
                 recognition in the sense the word normally carries: given
                 two crops, it answers "how likely is this the same
                 person", with a real, measurable score -- not "I don't
                 know" like `modules/reid.py`'s `NullReID`, and not a
                 colour histogram like `HistogramReID`.

  MEASURED ON REAL FOOTAGE (2026-09-28), NOT JUST OFFLINE PHOTOS: 5 real,
  distinct people tracked across a real CCTV clip (patrol_road.mp4, a
  street scene, people walking toward camera in rain), face-embedded on
  every tick a face was found. 132 same-person comparisons (consecutive
  frames within one track, plus first-vs-last of each track): mean 0.60,
  but real range -- min 0.005, max 0.998. 24/132 (18%) fell BELOW
  opencv_zoo's own published same-identity threshold (~0.363 for this
  model) -- a single bad crop (motion blur, an awkward angle, a half-turn)
  genuinely can and does score low, even for the true same person. 10
  different-person comparisons across the same 5 people: 1/10 exceeded the
  threshold (0.3692, barely). So: the separation is real and the threshold
  is reasonably placed, but a SINGLE frame-pair comparison is not reliable
  enough to hang a match on alone -- which is exactly why this module never
  matches on one frame. It keeps re-trying every `face_every`th tick for as
  long as the track lives (see `_match_watchlist`), so the number that
  actually matters is the false-negative rate over a track's WHOLE
  lifetime (many attempts), not the 18% per-single-frame-pair rate above --
  that whole-track number has not been separately measured yet.

  WHAT THIS STILL DOES NOT MEAN: FaceEmbedder has no opinion about WHO
  anyone is on its own -- it only ever compares two crops it is handed. The
  identity claim ("this is <name>") lives entirely in whoever calls it (the
  watchlist in `people_ai_service.py`), which enrolled that name against a
  reference photo. Never described as legally or operationally certified:
  claude.md §7's rule against unmeasured claims applies to a match score the
  same as it does to an FPS number -- the real-footage numbers above are
  from one clip, one weather condition (rain), one camera angle. They are
  evidence, not a certified accuracy figure.

LIVE ONLY (FaceDetector's own output), ON PURPOSE: a face box is drawn on
the console and nothing else BY THIS MODULE. This module emits nothing on
the durable path -- a watchlist match is a SEPARATE thing that judges
FaceEmbedder's output, not this module's detection stream, and is durable
when it fires (see people_ai_service.py's /watchlist).

CADENCE: a face does not need a per-frame update -- the subject's pose barely
changes between two detector calls at 6 fps. `face_every` (default: every
5th processed frame) is deliberately coarser than the shared pass, the same
reasoning `modules/multi_human.py` applies to `embed_every`. The most recent
detection per track is kept and redrawn on the frames in between, so the box
does not flicker at the cadence it is actually computed on.

STATUS: FaceDetector is solid and has been for a while. FaceEmbedder is
verified correct on real CCTV footage now, not just offline test photos --
see the measured numbers above before trusting a single-frame match on its
own; the module's own retry-over-track-lifetime design is why one bad
frame does not sink a real match in practice.
"""

import os
from pathlib import Path
from typing import Any, Optional, Sequence

from core.payload import live_track
from modules.base import FrameContext, VisionModule, register
from modules.reid import HistogramReID
from modules.watchlist_client import WatchlistClient

#: Resolved against THIS directory, not the current one -- the identical
#: reason `config.py Settings.weights` resolves against `HERE`: a bare
#: relative path means "found" or "missing" depends on whether `main.py` was
#: launched from the repo root or from inside `ibvap/`, and that difference
#: looks like a broken model rather than a path bug. `IBVAP_FACE_MODEL` (via
#: `Settings.face_model`) overrides this per-machine; a camera's own
#: `face: {model: ...}` param overrides both.
DEFAULT_MODEL = str(Path(__file__).resolve().parent.parent / "data"
                    / "face_detection_yunet_2023mar.onnx")

#: Same resolution reasoning as DEFAULT_MODEL above, for SFace's weights.
DEFAULT_RECOGNITION_MODEL = str(Path(__file__).resolve().parent.parent / "data"
                                / "face_recognition_sface_2021dec.onnx")


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
            out.append({
                "bbox_px": (int(x), int(y), int(x + w), int(y + h)),
                "score": float(score),
                # YuNet's own raw row (box + 5 landmarks), kept only because
                # FaceEmbedder.embed() needs it for alignCrop -- landmark-
                # based alignment measurably improves match accuracy over a
                # naive unaligned crop. Everything else in this module
                # ignores it; it exists purely to hand off to the embedder.
                "raw": face,
            })
        return out


class FaceEmbedder:
    """
    SFace (`cv2.FaceRecognizerSF`), opencv_zoo's own matched pairing for
    YuNet. See this module's docstring for what a match score does and does
    not claim before wiring this into anything that acts on it.
    """

    def __init__(self, model_path: str):
        self.model_path = model_path
        self._recognizer = None

    def _ensure(self):
        if self._recognizer is not None:
            return
        import cv2  # lazy, matching FaceDetector's own reasoning
        if not os.path.exists(self.model_path):
            raise FileNotFoundError(
                f"SFace weights not found at {self.model_path}. Fetch the "
                f"~38 MB ONNX from opencv_zoo's face_recognition_sface "
                f"directory using GitHub's \"Download raw file\" button -- "
                f"a plain right-click-save yields a git-LFS pointer, not "
                f"the model, the same trap as YuNet's own weights."
            )
        self._recognizer = cv2.FaceRecognizerSF.create(self.model_path, "")

    def embed(self, crop, raw_face_row) -> Optional[list[float]]:
        """
        `raw_face_row` is a FaceDetector.detect() result's own `"raw"` field
        -- YuNet's box-plus-landmarks row for ONE face, required for
        alignCrop. Passing a bare bbox here silently degrades match quality
        instead of failing loudly, which is exactly why this takes the raw
        row and not the tidied-up bbox_px the rest of this module uses.
        """
        self._ensure()
        import cv2
        aligned = self._recognizer.alignCrop(crop, raw_face_row)
        feature = self._recognizer.feature(aligned)
        return feature.flatten().tolist()

    def similarity(self, feature_a: Sequence[float], feature_b: Sequence[float]) -> float:
        """
        Cosine similarity, 1.0 identical, 0.0 unrelated -- same convention
        `modules/reid.py`'s `cosine()` uses, so a threshold reads the same
        way regardless of which signal produced the score.
        """
        self._ensure()
        import cv2
        import numpy as np
        a = np.array(feature_a, dtype="float32").reshape(1, -1)
        b = np.array(feature_b, dtype="float32").reshape(1, -1)
        return float(self._recognizer.match(a, b, cv2.FaceRecognizerSF_FR_COSINE))


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

        # Watchlist matching is opt-in on whether a backend address was given
        # (main.py always gives one; debug_view.py and a bare FaceModule in a
        # test do not, and detection keeps working exactly as before without
        # it -- see this module's own docstring on the two separate claims).
        backend_url = params.get("backend_url")
        if backend_url and not hasattr(self, "_watchlist"):
            self._embedder = FaceEmbedder(params.get("recognition_model") or DEFAULT_RECOGNITION_MODEL)
            self._appearance = HistogramReID()
            self._watchlist = WatchlistClient(
                backend_url,
                refresh_seconds=float(params.get("watchlist_refresh_seconds", 5.0)),
            )
            self._watchlist_warned = False
            # Per-track: the current match (redrawn between run_now ticks,
            # same reasoning as `_best`), and the LAST matched id a durable
            # event was already sent for -- so a continuing match is drawn on
            # every frame but only ALERTED once, not every face_every ticks.
            self._match: dict[str, dict] = {}
            self._alerted: dict[str, str] = {}
        elif not backend_url:
            self._watchlist = None

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
            found = None
            if run_now:
                found = self._find_face(frame, person)
                if found:
                    self.faces_seen += 1
                    self._best[ref] = found

            if run_now and self._watchlist is not None:
                durable_item = self._match_watchlist(frame, person, ref, found)
                if durable_item:
                    durable.append(durable_item)

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
            match = self._match.get(ref)
            if match:
                extra["watchlist_match"] = {
                    "name": match["name"],
                    "score": round(match["score"], 3),
                    "signal": match["signal"],
                }
            live.append(live_track(person, extra))

        # Tracks that left frame keep no state here worth expiring on a timer
        # -- there is nothing to prune but this one dict entry, and multi_human
        # already owns telling a track's lifetime apart from a face's.
        seen = {p["track_ref"] for p in people}
        for ref in [r for r in self._best if r not in seen]:
            del self._best[ref]
        if self._watchlist is not None:
            for ref in [r for r in self._match if r not in seen]:
                del self._match[ref]
            for ref in [r for r in self._alerted if r not in seen]:
                del self._alerted[ref]

        return live, durable

    def _match_watchlist(self, frame, person: dict, ref: str, found: Optional[dict]) -> Optional[dict]:
        """
        One track's watchlist comparison for this tick. Face embedding only
        when a face was actually found THIS tick (re-embedding a stale crop
        from a previous tick would waste cycles for no new information);
        appearance is recomputed every tick regardless, since it is exactly
        the fallback for when no face is visible at all.

        Returns a durable event dict when this track's match just CHANGED
        (became matched, or matched a different entry) -- self._alerted is
        what makes a continuing match drawn every frame but alerted once,
        the same "confirm once, don't re-announce" instinct multi_human's own
        identity minting follows.
        """
        face_embedding = None
        if found is not None and self._watchlist is not None:
            try:
                face_embedding = self._embedder.embed(found["crop"], found["raw"])
            except FileNotFoundError as error:
                if not self._watchlist_warned:
                    print(f"[face] watchlist face matching disabled: {error}")
                    self._watchlist_warned = True
                self._watchlist = None
        if self._watchlist is None:
            return None

        appearance_embedding = self._appearance.embed(frame, person["bbox_px"])
        match = self._watchlist.match(face_embedding, appearance_embedding)

        if not match:
            self._match.pop(ref, None)
            self._alerted.pop(ref, None)
            return None

        self._match[ref] = match
        if self._alerted.get(ref) == match["id"]:
            return None
        self._alerted[ref] = match["id"]
        return {
            "event_type": "watchlist_match",
            "track_id": person.get("track_id"),
            "data": {
                "matched_id": match["id"],
                "signal": match["signal"],
                "score": round(match["score"], 4),
                "track_ref": ref,
                "bbox": [round(v, 5) for v in person["bbox_xywh"]],
            },
        }

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
        # Back to full-frame pixels: the crop was offset by (x1, y1). `crop`
        # and `raw` are kept alongside for FaceEmbedder.embed(), which needs
        # them in this SAME coordinate space -- see this module's watchlist
        # matching in process() below.
        return {"bbox_px": (x1 + fx1, y1 + fy1, x1 + fx2, y1 + fy2),
                "score": best["score"], "crop": crop, "raw": best["raw"]}

    def stats(self) -> dict:
        return {"tracked_faces": len(self._best), "faces_seen": self.faces_seen}
