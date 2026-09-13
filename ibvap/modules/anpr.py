"""
ANPR: read the number plate of a vehicle the shared pass already found.

THE CORE IDEA: no second detector. OCR runs on the lower-centre slice of an
already-tracked vehicle box, never across the full frame.

  Compute        a few hundred pixels instead of 2.07 M. OCR is far more
                 expensive than YOLO here, so this is the difference between a
                 usable pipeline and a slideshow.
  False positives  plate hallucinations on signage, foliage and reflections are
                 excluded BY CONSTRUCTION, not by threshold tuning. A border
                 scene is full of exactly those textures.
  Attribution    every read arrives already bound to a track, so a watchlist
                 check happens once per vehicle rather than once per frame.
                 That is a direct attack on operator alert fatigue.

A dedicated plate-detection model would be a second model to install, tune and
defend for accuracy this does not need at a gate. One less thing to break.

LIVE vs DURABLE, and the line between them:
  live     every vehicle box, plus the current best OCR guess if there is one.
           Unconfirmed. The console may draw it; nothing may act on it.
  durable  a read that passed the plausibility gate, at most once per
           (track, text) per `report_interval`. A tracked vehicle is visible in
           dozens of detector calls and would otherwise flood the record with
           clones of one fact.

THE GATE — why a read is rejected rather than reported at low confidence:
"PB02AK4821" and "" are useful answers. "8" is not: it is scene text, a bumper
sticker, or half a plate, and a watchlist that matches on fragments raises
alarms about vehicles nobody was looking for. A read is accepted only at 6-12
characters, above the OCR confidence floor, containing BOTH a letter and a
digit. Everything else is dropped without being reported as a plate at all.

STATUS: prototype.
"""

import re
import time
from typing import Any, Optional

import cv2

from core.payload import live_track
from modules.base import FrameContext, VisionModule, register


def normalise_plate(raw: Optional[str]) -> str:
    if not raw:
        return ""
    return re.sub(r"[^A-Z0-9]", "", str(raw).upper()).strip()


class PlateReader:
    """
    The OCR half, kept separate from the module so `ai_service.py` can use the
    identical reading path for the browser scanner. One plate-reading
    implementation in the process, not two that drift.
    """

    ALLOWLIST = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

    def __init__(self, ocr_confidence=0.45, read_interval=1.5, languages=("en",)):
        import easyocr  # heavy; imported here so a fence-only camera never pays

        # verbose=False is NOT cosmetic on Windows. EasyOCR's download progress
        # bar prints U+2588 block characters, a cp1252 console cannot encode
        # them, and the UnicodeEncodeError propagates out of the download and
        # kills the model fetch on first run. The failure looks like "ANPR is
        # broken" and is actually "a progress bar could not be printed".
        # Silencing the hook is the fix that needs no environment variable and
        # therefore cannot be forgotten on somebody else's laptop.
        print("[anpr] loading EasyOCR models (first run downloads ~100 MB)...",
              flush=True)
        self.reader = easyocr.Reader(list(languages), gpu=False, verbose=False)
        print("[anpr] EasyOCR ready", flush=True)
        self.ocr_confidence = ocr_confidence
        self.read_interval = read_interval
        self._recent: dict[Any, tuple[float, str, float]] = {}

    @staticmethod
    def plate_region(bbox_px, frame_shape, lower_frac=0.45, center_w_frac=0.60):
        """
        The lower-central slice of a vehicle box, where a plate sits.

        Fractions rather than pixels because a lorry at the gate and a
        motorcycle at the far end of the road are the same shape problem at
        different scales.
        """
        x1, y1, x2, y2 = bbox_px
        w, h = x2 - x1, y2 - y1
        py1 = y1 + int(h * (1.0 - lower_frac))
        py2 = y2
        margin = int(w * (1.0 - center_w_frac) / 2)
        px1, px2 = x1 + margin, x2 - margin
        height, width = frame_shape[:2]
        return max(0, px1), max(0, py1), min(width, px2), min(height, py2)

    def read(self, frame, bbox_px, cache_key=None) -> Optional[dict]:
        """
        Return `{text, confidence, bbox}` in SOURCE pixels, or None.

        A recent read is reused per track for `read_interval` seconds: the
        plate has not changed, and re-running OCR on every detector call is the
        single most expensive thing this service could choose to do.
        """
        px1, py1, px2, py2 = self.plate_region(bbox_px, frame.shape)
        if px2 - px1 < 20 or py2 - py1 < 10:
            return None  # too few pixels to be a plate rather than a smudge

        now = time.monotonic()
        cached = self._recent.get(cache_key) if cache_key is not None else None
        if cached and now - cached[0] < self.read_interval:
            return {"text": cached[1], "confidence": cached[2],
                    "bbox": (px1, py1, px2, py2), "cached": True}

        crop = frame[py1:py2, px1:px2]
        if crop is None or crop.size == 0:
            return None
        # Small plates need enlargement and contrast recovery before OCR. This
        # is still an OCR result, never a guessed plate.
        crop = cv2.resize(crop, None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)

        readings = self.reader.readtext(gray, detail=1, allowlist=self.ALLOWLIST)
        if not readings:
            return None

        # OCR often yields state, series and number as separate tokens. Preserve
        # their left-to-right order before validating, or "PB02" + "AK4821"
        # reassembles backwards on a whim.
        readings.sort(key=lambda item: min(point[0] for point in item[0]))
        text = normalise_plate("".join(item[1] for item in readings))
        confidence = sum(float(item[2]) for item in readings) / len(readings)

        if not (6 <= len(text) <= 12
                and confidence >= self.ocr_confidence
                and any(c.isalpha() for c in text)
                and any(c.isdigit() for c in text)):
            return None

        # OCR polygons are on the 4x crop. Convert back to a tight source-frame
        # box, so what gets saved as evidence is the registration plate and not
        # the whole car body.
        points = [point for reading in readings for point in reading[0]]
        rx1 = max(px1, px1 + int(min(p[0] for p in points) / 4) - 8)
        ry1 = max(py1, py1 + int(min(p[1] for p in points) / 4) - 5)
        rx2 = min(px2, px1 + int(max(p[0] for p in points) / 4) + 8)
        ry2 = min(py2, py1 + int(max(p[1] for p in points) / 4) + 5)

        if cache_key is not None:
            self._recent[cache_key] = (now, text, confidence)
            if len(self._recent) > 512:  # bound memory on a busy camera
                oldest = min(self._recent, key=lambda k: self._recent[k][0])
                del self._recent[oldest]

        return {"text": text, "confidence": confidence,
                "bbox": (rx1, ry1, rx2, ry2), "cached": False}


@register
class AnprModule(VisionModule):
    name = "anpr"

    def configure(self, params: dict[str, Any]) -> None:
        super().configure(params)
        self.report_interval = float(params.get("report_interval", 8.0))
        self.ocr_every = max(1, int(params.get("ocr_every", 1)))
        self._ocr_confidence = float(params.get("ocr_confidence", 0.45))
        self._read_interval = float(params.get("read_interval", 1.5))

        if not hasattr(self, "_reader"):
            self._reader: Optional[PlateReader] = None
            self._reported: dict[str, float] = {}
            self.reads = 0
            self.accepted = 0
        elif self._reader is not None:
            self._reader.ocr_confidence = self._ocr_confidence
            self._reader.read_interval = self._read_interval

    @property
    def reader(self) -> PlateReader:
        # Built on first use. A camera configured for ANPR that never sees a
        # vehicle should not pay EasyOCR's model load at startup.
        if self._reader is None:
            self._reader = PlateReader(ocr_confidence=self._ocr_confidence,
                                       read_interval=self._read_interval)
        return self._reader

    def process(self, frame, detections: list[dict], ctx: FrameContext):
        live: list[dict] = []
        durable: list[dict] = []

        vehicles = [d for d in detections if d.get("is_vehicle")]
        if not vehicles:
            return live, durable

        run_ocr = ctx.frame_index % self.ocr_every == 0

        for vehicle in vehicles:
            plate = None
            if run_ocr:
                self.reads += 1
                plate = self.reader.read(frame, vehicle["bbox_px"],
                                         cache_key=vehicle.get("track_ref"))

            extra: dict[str, Any] = {
                "track_ref": vehicle.get("track_ref"),
                "vehicle_type": vehicle["subtype"],
            }
            if plate:
                height, width = frame.shape[:2]
                px1, py1, px2, py2 = plate["bbox"]
                plate_norm = [px1 / width, py1 / height,
                              (px2 - px1) / width, (py2 - py1) / height]
                # The live guess. Unconfirmed by definition — the console draws
                # it, and nothing downstream is allowed to act on it.
                extra["plate"] = {
                    "text": plate["text"],
                    "confidence": round(plate["confidence"], 4),
                    "bbox": [round(v, 5) for v in plate_norm],
                    "confirmed": False,
                }
                # Carried on the detection so the migration-shim box frame can
                # still show a plate to the current console. Removed with it.
                vehicle["plate"] = {
                    "text": plate["text"],
                    "confidence": round(plate["confidence"], 4),
                    "bbox": [round(v, 5) for v in plate_norm],
                }

                event = self._report(vehicle, plate, plate_norm, ctx)
                if event:
                    durable.append(event)

            live.append(live_track(vehicle, extra))

        return live, durable

    def _report(self, vehicle, plate, plate_norm, ctx: FrameContext) -> Optional[dict]:
        ref = vehicle.get("track_ref")
        if not ref:
            return None
        key = f"{ref}:{plate['text']}"
        last = self._reported.get(key, 0.0)
        if ctx.ts - last < self.report_interval:
            return None
        self._reported[key] = ctx.ts
        self.accepted += 1
        return {
            "event_type": "plate_read",
            "track_id": vehicle.get("track_id"),
            "data": {
                "track_ref": ref,
                "plate": plate["text"],
                "plate_confidence": round(float(plate["confidence"]), 4),
                "plate_bbox": [round(v, 5) for v in plate_norm],
                "vehicle_type": vehicle["subtype"],
                "confidence": round(float(vehicle["confidence"]), 4),
                "bbox": [round(v, 5) for v in vehicle["bbox_xywh"]],
            },
        }

    def stats(self) -> dict:
        return {"ocr_calls": self.reads, "reads_reported": self.accepted}
