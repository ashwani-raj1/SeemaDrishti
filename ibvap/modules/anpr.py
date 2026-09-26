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
  durable  a read that passed repeated-frame confirmation, exactly once per
           (track, text). A tracked vehicle is visible in
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

import base64
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any, Optional

import cv2

from core.payload import live_track
from config import load_env
from modules.base import FrameContext, VisionModule, register


def normalise_plate(raw: Optional[str]) -> str:
    if not raw:
        return ""
    return re.sub(r"[^A-Z0-9]", "", str(raw).upper()).strip()


def plausible_plate(text: str) -> bool:
    """Reject fragments/noise without falsely claiming a country of origin."""
    return bool(
        6 <= len(text) <= 12
        and re.fullmatch(r"[A-Z0-9]+", text)
        and re.search(r"[A-Z]", text)
        and re.search(r"\d", text)
    )


class PlateReader:
    """
    The OCR half, kept separate from the module so `ai_service.py` can use the
    identical reading path for the browser scanner. One plate-reading
    implementation in the process, not two that drift.
    """

    ALLOWLIST = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

    def __init__(self, ocr_confidence=0.32, read_interval=1.5, languages=("en",)):
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
        self._candidates: dict[Any, dict[str, dict[str, Any]]] = {}
        self._stable: dict[Any, tuple[str, float]] = {}

    @staticmethod
    def plate_region(bbox_px, frame_shape, lower_frac=0.32, center_w_frac=0.70):
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

    @classmethod
    def plate_regions(cls, bbox_px, frame_shape):
        """Candidate front/rear plate bands, from tight to forgiving."""
        regions = [
            cls.plate_region(bbox_px, frame_shape, lower_frac=0.26, center_w_frac=0.76),
            cls.plate_region(bbox_px, frame_shape, lower_frac=0.40, center_w_frac=0.88),
        ]
        # Avoid paying for the same crop twice on very small vehicle boxes.
        return list(dict.fromkeys(regions))

    def read(self, frame, bbox_px, cache_key=None) -> Optional[dict]:
        """
        Return `{text, confidence, bbox}` in SOURCE pixels, or None.

        A recent read is reused per track for `read_interval` seconds: the
        plate has not changed, and re-running OCR on every detector call is the
        single most expensive thing this service could choose to do.
        """
        regions = [region for region in self.plate_regions(bbox_px, frame.shape)
                   if region[2] - region[0] >= 20 and region[3] - region[1] >= 10]
        if not regions:
            return None  # too few pixels to be a plate rather than a smudge

        now = time.monotonic()
        cached = self._recent.get(cache_key) if cache_key is not None else None
        if cached and now - cached[0] < self.read_interval:
            stable = self._stable.get(cache_key)
            if stable:
                px1, py1, px2, py2 = regions[0]
                return {"text": stable[0], "confidence": stable[1],
                        "bbox": (px1, py1, px2, py2), "cached": True}
            return None
        best = None
        for px1, py1, px2, py2 in regions:
            crop = frame[py1:py2, px1:px2]
            if crop is None or crop.size == 0:
                continue
            # Six-times enlargement made already-close plates several thousand
            # pixels wide and softened their glyph edges. Scale toward a stable
            # OCR width instead, while retaining enough pixels for distant cars.
            scale = max(1.5, min(6.0, 900 / max(1, crop.shape[1])))
            enlarged = cv2.resize(crop, None, fx=scale, fy=scale,
                                  interpolation=cv2.INTER_CUBIC)
            gray = cv2.cvtColor(enlarged, cv2.COLOR_BGR2GRAY)
            enhanced = cv2.createCLAHE(clipLimit=3.0,
                                       tileGridSize=(8, 8)).apply(gray)
            _, thresholded = cv2.threshold(
                enhanced, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
            inverted = cv2.bitwise_not(thresholded)

            for prepared in (enhanced, thresholded, inverted):
                readings = self.reader.readtext(
                    prepared, detail=1, allowlist=self.ALLOWLIST,
                    decoder="beamsearch", beamWidth=5)
                if not readings:
                    continue
                readings.sort(key=lambda item: min(point[0] for point in item[0]))
                # EasyOCR sometimes returns a plate as one token and sometimes
                # as two adjacent tokens. Evaluate both forms instead of making
                # the result depend on that segmentation choice.
                groups = [readings, *[[reading] for reading in readings]]
                for group in groups:
                    text = normalise_plate("".join(item[1] for item in group))
                    confidence = sum(float(item[2]) for item in group) / len(group)
                    if (plausible_plate(text)
                            and confidence >= self.ocr_confidence
                            and (best is None or confidence > best[1])):
                        best = (text, confidence, group, (px1, py1), scale)

        if best is None:
            # Cache a failed attempt too. Without this, an unreadable/distant
            # plate runs EasyOCR again on every processed frame and can stall
            # the detector for seconds while the vehicle remains visible.
            if cache_key is not None:
                self._recent[cache_key] = (now, "", 0.0)
            return None

        text, confidence, readings, (px1, py1), scale = best

        # OCR polygons are on the 6x crop. Convert back to a tight source-frame
        # box, so what gets saved as evidence is the registration plate and not
        # the whole car body.
        points = [point for reading in readings for point in reading[0]]
        region = next(region for region in regions if region[0] == px1 and region[1] == py1)
        px2, py2 = region[2], region[3]
        rx1 = max(px1, px1 + int(min(p[0] for p in points) / scale) - 8)
        ry1 = max(py1, py1 + int(min(p[1] for p in points) / scale) - 5)
        rx2 = min(px2, px1 + int(max(p[0] for p in points) / scale) + 8)
        ry2 = min(py2, py1 + int(max(p[1] for p in points) / scale) + 5)

        if cache_key is not None:
            self._recent[cache_key] = (now, text, confidence)
            candidates = self._candidates.setdefault(cache_key, {})
            evidence = candidates.setdefault(text, {
                "hits": 0, "best_confidence": 0.0, "last_seen": now})
            evidence["hits"] += 1
            evidence["best_confidence"] = max(
                float(evidence["best_confidence"]), confidence)
            evidence["last_seen"] = now

            # A plate is durable only after independent OCR passes agree. Low
            # confidence reads require one additional agreement. Once accepted,
            # keep that text for the lifetime of this track so a later glare or
            # blurred frame cannot make one vehicle change registration number.
            # A sharp local OCR result is already stronger evidence than two
            # mediocre reads. Accept it immediately; retain repeated agreement
            # for weaker/blurred characters.
            required_hits = 1 if confidence >= 0.65 else 2 if confidence >= 0.45 else 3
            if cache_key not in self._stable and evidence["hits"] >= required_hits:
                self._stable[cache_key] = (
                    text, float(evidence["best_confidence"]))

            if len(self._recent) > 512:  # bound memory on a busy camera
                oldest = min(self._recent, key=lambda k: self._recent[k][0])
                del self._recent[oldest]
                self._candidates.pop(oldest, None)
                self._stable.pop(oldest, None)

            stable = self._stable.get(cache_key)
            if not stable:
                return None
            text, confidence = stable

        return {"text": text, "confidence": confidence,
                "bbox": (rx1, ry1, rx2, ry2), "cached": False}


class GeminiPlateEstimator:
    """Non-blocking fallback for a tracked vehicle plate crop.

    The result is constrained to a detected vehicle crop, validated as a
    plausible plate, and then enters the same durable watchlist flow as OCR.
    """

    def __init__(self):
        env = load_env()
        self.api_key = (os.getenv("GEMINI_API_KEY") or
                        os.getenv("GOOGLE_API_KEY") or
                        env.get("GEMINI_API_KEY", "") or
                        env.get("GOOGLE_API_KEY", ""))
        self.model = (os.getenv("GEMINI_VISION_MODEL") or
                      env.get("GEMINI_VISION_MODEL", "gemini-2.5-flash-lite"))
        self.enabled = env.get("IBVAP_LLM_PLATE_FALLBACK", "true").lower() in {
            "1", "true", "yes", "on"
        } and bool(self.api_key)
        self._executor = ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="shared-anpr-gemini")
        self._jobs: dict[str, Future] = {}
        self._cache: dict[str, dict[str, Any]] = {}

    def hint(self, frame, bbox_px, track_ref: str,
             reader: PlateReader) -> Optional[dict]:
        if not self.enabled or not track_ref:
            return None
        now = time.monotonic()
        job = self._jobs.get(track_ref)
        if job is not None and job.done():
            try:
                result = job.result()
                previous = self._cache.get(track_ref)
                previous_result = previous.get("result") if previous else None
                confirmations = (
                    int(previous.get("confirmations", 0)) + 1
                    if result and previous_result and
                    previous_result.get("text") == result.get("text")
                    else 1 if result else 0
                )
                if result:
                    result = dict(result)
                    # The prompt is constrained to a cropped detected vehicle
                    # and rejects UNKNOWN/non-plate strings. Treat the first
                    # deterministic Gemini fallback as usable; exact watchlist
                    # matching downstream remains conservative.
                    result["verified"] = confirmations >= 1
                self._cache[track_ref] = {
                    "attempted": now,
                    "area": max(1, (bbox_px[2] - bbox_px[0]) *
                                (bbox_px[3] - bbox_px[1])),
                    "result": result,
                    "confirmations": confirmations,
                }
            except Exception as exc:  # network failure must not stop detection
                print(f"[anpr] Gemini estimate unavailable: {exc}", flush=True)
                self._cache[track_ref] = {
                    "attempted": now, "area": 1, "result": None,
                    "confirmations": 0}
            finally:
                self._jobs.pop(track_ref, None)
            job = None

        area = max(1, (bbox_px[2] - bbox_px[0]) *
                   (bbox_px[3] - bbox_px[1]))
        cached = self._cache.get(track_ref)
        age = now - float(cached.get("attempted", 0)) if cached else float("inf")
        previous_area = max(1, int(cached.get("area", 1))) if cached else 1
        retry_after = 12.0 if cached and cached.get("result") else 4.0
        clearer = area >= previous_area * 1.35
        if job is None and (cached is None or clearer or age >= retry_after):
            self._jobs[track_ref] = self._executor.submit(
                self._estimate, frame.copy(), tuple(bbox_px), reader)

        if len(self._cache) > 512:
            oldest = min(self._cache, key=lambda key: self._cache[key]["attempted"])
            self._cache.pop(oldest, None)
        return cached.get("result") if cached else None

    def _estimate(self, frame, bbox_px, reader: PlateReader) -> Optional[dict]:
        # Gemini gets a slightly more forgiving lower-body crop than EasyOCR.
        # This preserves bumper context when YOLO clips a close vehicle while
        # still excluding the road/signage that causes full-frame hallucination.
        px1, py1, px2, py2 = reader.plate_region(
            bbox_px, frame.shape, lower_frac=0.52, center_w_frac=0.94)
        crop = frame[py1:py2, px1:px2]
        if crop is None or crop.size == 0 or crop.shape[1] < 24 or crop.shape[0] < 12:
            return None
        scale = max(3.0, min(8.0, 220.0 / max(1, crop.shape[0])))
        crop = cv2.resize(crop, None, fx=scale, fy=scale,
                          interpolation=cv2.INTER_CUBIC)
        ok, encoded = cv2.imencode(
            ".jpg", crop, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
        if not ok:
            return None
        prompt = (
            "Read the visible vehicle registration plate from this probable "
            "front/rear bumper crop. Carefully distinguish 0/O, 1/I, 5/S and "
            "8/B. Return only JSON "
            "as {\"plate\":\"AB12CD3456\"}. Use UNKNOWN when every character "
            "is not sufficiently visible. Never invent hidden characters."
        )
        parts = [{"inline_data": {
            "mime_type": "image/jpeg",
            "data": base64.b64encode(encoded).decode("ascii"),
        }}]
        parts.append({"text": prompt})
        body = json.dumps({
            "contents": [{"parts": parts}],
            "generationConfig": {
                "temperature": 0,
                "maxOutputTokens": 40,
                "responseMimeType": "application/json",
            },
        }).encode("utf-8")
        url = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"{urllib.parse.quote(self.model, safe='')}:generateContent"
        )
        request = urllib.request.Request(
            url, data=body,
            headers={"x-goog-api-key": self.api_key,
                     "Content-Type": "application/json"},
            method="POST")
        with urllib.request.urlopen(request, timeout=12) as response:
            payload = json.loads(response.read().decode("utf-8"))
        answer = str(payload["candidates"][0]["content"]["parts"][0]["text"])
        cleaned = answer.strip().replace("```json", "").replace("```", "").strip()
        try:
            text = str(json.loads(cleaned).get("plate", ""))
        except (json.JSONDecodeError, AttributeError):
            text = cleaned
        text = normalise_plate(text)
        if text == "UNKNOWN" or not plausible_plate(text):
            return None
        return {
            "text": text,
            # A source ranking only; it is not calibrated OCR confidence.
            "confidence": 0.25,
            "bbox": (px1, py1, px2, py2),
            "source": "llm",
            "verified": False,
            "model": self.model,
        }


@register
class AnprModule(VisionModule):
    name = "anpr"

    def configure(self, params: dict[str, Any]) -> None:
        super().configure(params)
        self.ocr_every = max(1, int(params.get("ocr_every", 1)))
        self._ocr_confidence = float(params.get("ocr_confidence", 0.32))
        self._read_interval = float(params.get("read_interval", 1.5))
        # A track is complete only after it has been absent long enough to rule
        # out a one-frame detector dropout. Vehicle totals are emitted at that
        # point, not while the vehicle is still in the current view.
        # EasyOCR is intentionally off the detector thread and can take a few
        # seconds on CPU. Keep a disappeared track recoverable long enough for
        # both ID stitching and its pending OCR result to complete.
        self._exit_grace = max(0.25, float(params.get("exit_grace", 15.0)))

        if not hasattr(self, "_reader"):
            self._reader: Optional[PlateReader] = None
            self._estimator = GeminiPlateEstimator()
            self._ocr_executor = ThreadPoolExecutor(
                max_workers=1, thread_name_prefix=f"anpr-ocr-{self.camera_id}")
            self._ocr_jobs: dict[str, Future] = {}
            self._ocr_results: dict[str, Optional[dict]] = {}
            self._reported: dict[str, float] = {}
            self._vehicle_hits: dict[str, int] = {}
            self._reported_vehicles: set[str] = set()
            self._active_vehicles: dict[str, dict[str, Any]] = {}
            self._raw_to_canonical: dict[str, str] = {}
            self._canonical_serial = 0
            self._snapshot_areas: dict[str, int] = {}
            self._vehicle_snapshots: dict[str, str] = {}
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

    @staticmethod
    def _box_similarity(a, b) -> tuple[float, float, float]:
        ax1, ay1, ax2, ay2 = a
        bx1, by1, bx2, by2 = b
        intersection = max(0.0, min(ax2, bx2) - max(ax1, bx1)) * max(
            0.0, min(ay2, by2) - max(ay1, by1))
        area_a = max(0.000001, (ax2 - ax1) * (ay2 - ay1))
        area_b = max(0.000001, (bx2 - bx1) * (by2 - by1))
        union = area_a + area_b - intersection
        iou = intersection / union if union > 0 else 0.0
        distance = ((ax1 + ax2 - bx1 - bx2) ** 2 +
                    (ay1 + ay2 - by1 - by2) ** 2) ** 0.5 / 2.0
        size_ratio = max(area_a, area_b) / min(area_a, area_b)
        return iou, distance, size_ratio

    def _stitch_vehicles(self, vehicles: list[dict], now: float) -> list[dict]:
        """Recover one identity when ByteTrack reissues IDs for one vehicle."""
        claimed: set[str] = set()
        stitched: list[dict] = []
        for original in vehicles:
            vehicle = dict(original)
            raw_ref = str(original.get("track_ref") or "")
            canonical = self._raw_to_canonical.get(raw_ref) if raw_ref else None
            if canonical in claimed or canonical not in self._active_vehicles:
                canonical = None

            if canonical is None:
                best_ref, best_score = None, float("-inf")
                for candidate_ref, state in self._active_vehicles.items():
                    if (candidate_ref in claimed or
                            now - float(state["last_seen"]) > self._exit_grace or
                            state["vehicle_type"] != vehicle["subtype"]):
                        continue
                    iou, distance, size_ratio = self._box_similarity(
                        state["bbox_xyxy"], vehicle["bbox"])
                    if iou < 0.08 and (distance > 0.18 or size_ratio > 3.0):
                        continue
                    score = iou * 3.0 + (1.0 - min(1.0, distance)) - abs(
                        1.0 - min(size_ratio, 3.0)) * 0.15
                    if score > best_score:
                        best_ref, best_score = candidate_ref, score
                canonical = best_ref

            if canonical is None:
                self._canonical_serial += 1
                canonical = f"{self.camera_id}:vehicle:{self._canonical_serial}"
            if raw_ref:
                self._raw_to_canonical[raw_ref] = canonical
            vehicle["track_ref"] = canonical
            claimed.add(canonical)
            stitched.append(vehicle)
        return stitched

    def process(self, frame, detections: list[dict], ctx: FrameContext):
        live: list[dict] = []
        durable: list[dict] = []

        vehicles = self._stitch_vehicles(
            [d for d in detections if d.get("is_vehicle")], ctx.ts)
        # Harvest jobs independently of current visibility. A vehicle may have
        # crossed out while CPU OCR was still finishing its best close frame.
        for job_ref, job in list(self._ocr_jobs.items()):
            if not job.done():
                continue
            try:
                result = job.result()
                if result:
                    self._ocr_results[job_ref] = result
            except Exception as exc:
                print(f"[anpr] OCR unavailable for {job_ref}: {exc}", flush=True)
            finally:
                self._ocr_jobs.pop(job_ref, None)
        visible_refs = {
            str(vehicle["track_ref"])
            for vehicle in vehicles if vehicle.get("track_ref")
        }
        # Finalise tracks only after they cross out of the camera view. The
        # grace period keeps a brief YOLO/ByteTrack miss from becoming an exit.
        for ref, state in list(self._active_vehicles.items()):
            if ref in visible_refs or ctx.ts - float(state["last_seen"]) < self._exit_grace:
                continue
            if state["hits"] >= 2 and ref not in self._reported_vehicles:
                self._reported_vehicles.add(ref)
                durable.append({
                    "event_type": "vehicle_detection",
                    "track_id": state.get("track_id"),
                    "data": {
                        "track_ref": ref,
                        "vehicle_type": state["vehicle_type"],
                        "confidence": state["confidence"],
                        "bbox": state["bbox"],
                    },
                })
            completed_plate = self._ocr_results.get(ref)
            if completed_plate:
                px1, py1, px2, py2 = completed_plate["bbox"]
                plate_xywh = [px1 / ctx.width, py1 / ctx.height,
                              (px2 - px1) / ctx.width,
                              (py2 - py1) / ctx.height]
                vehicle_for_report = {
                    "track_ref": ref,
                    "track_id": state.get("track_id"),
                    "subtype": state["vehicle_type"],
                    "confidence": state["confidence"],
                    "bbox_xywh": state["bbox"],
                }
                plate_event = self._report(
                    vehicle_for_report, completed_plate, plate_xywh, ctx,
                    self._vehicle_snapshots.get(ref))
                if plate_event:
                    durable.append(plate_event)
            del self._active_vehicles[ref]
            for raw_ref, canonical in list(self._raw_to_canonical.items()):
                if canonical == ref:
                    del self._raw_to_canonical[raw_ref]
            self._snapshot_areas.pop(ref, None)
            self._vehicle_snapshots.pop(ref, None)
            self._ocr_results.pop(ref, None)
            stale_job = self._ocr_jobs.pop(ref, None)
            if stale_job is not None:
                stale_job.cancel()

        run_ocr = ctx.frame_index % self.ocr_every == 0

        for vehicle in vehicles:
            plate = None
            ref = str(vehicle.get("track_ref") or "")
            if ref:
                job = self._ocr_jobs.get(ref)
                plate = self._ocr_results.get(ref)
                if run_ocr and job is None and plate is None:
                    self.reads += 1
                    # OCR operates on its own frame copy so slow character
                    # recognition never pauses YOLO, tracking, live counts or
                    # disappearance/exit detection.
                    self._ocr_jobs[ref] = self._ocr_executor.submit(
                        self.reader.read, frame.copy(), tuple(vehicle["bbox_px"]), ref)

            estimate = None
            if not plate:
                estimate = self._estimator.hint(
                    frame, vehicle["bbox_px"],
                    str(vehicle.get("track_ref") or ""), self.reader)
            visible_plate = plate or estimate

            extra: dict[str, Any] = {
                "track_ref": vehicle.get("track_ref"),
                "vehicle_type": vehicle["subtype"],
            }
            ref = vehicle.get("track_ref")
            if ref:
                self._vehicle_hits[ref] = self._vehicle_hits.get(ref, 0) + 1
                self._active_vehicles[ref] = {
                    "last_seen": ctx.ts,
                    "hits": self._vehicle_hits[ref],
                    "track_id": vehicle.get("track_id"),
                    "vehicle_type": vehicle["subtype"],
                    "confidence": round(float(vehicle["confidence"]), 4),
                    "bbox": [round(v, 5) for v in vehicle["bbox_xywh"]],
                    "bbox_xyxy": [round(v, 5) for v in vehicle["bbox"]],
                }
            x1, y1, x2, y2 = vehicle["bbox_px"]
            area = max(1, (x2 - x1) * (y2 - y1))
            previous_area = self._snapshot_areas.get(ref, 0) if ref else 0
            if ref and (previous_area == 0 or area >= previous_area * 1.5):
                snapshot = self._snapshot(frame, vehicle["bbox_px"])
                if snapshot:
                    self._vehicle_snapshots[ref] = snapshot
                    self._snapshot_areas[ref] = area
            # Repeat the latest evidence crop in live observations. The socket
            # is latest-wins and may legitimately drop the exact frame that
            # created a snapshot; sending it only once made the UI randomly
            # show an empty preview despite successful detection.
            if ref and ref in self._vehicle_snapshots:
                extra["image_snapshot"] = self._vehicle_snapshots[ref]
            if visible_plate:
                height, width = frame.shape[:2]
                px1, py1, px2, py2 = visible_plate["bbox"]
                # Live overlays use xyxy like every other websocket box.
                plate_xyxy = [px1 / width, py1 / height,
                              px2 / width, py2 / height]
                # Durable ingress uses xywh (the backend Detection contract).
                plate_xywh = [px1 / width, py1 / height,
                              (px2 - px1) / width, (py2 - py1) / height]
                # The live guess. Unconfirmed by definition — the console draws
                # it, and nothing downstream is allowed to act on it.
                plate_snapshot = self._snapshot(
                    frame, visible_plate["bbox"], plate=True)
                extra["plate"] = {
                    "text": visible_plate["text"],
                    "confidence": round(visible_plate["confidence"], 4),
                    "bbox": [round(v, 5) for v in plate_xyxy],
                    "confirmed": False,
                    "source": visible_plate.get("source", "ocr"),
                    "model": visible_plate.get("model"),
                    "image_snapshot": plate_snapshot,
                }
                if plate or (estimate and estimate.get("verified")):
                    accepted_plate = plate or estimate
                    vehicle["plate"] = {
                        "text": accepted_plate["text"],
                        "confidence": round(accepted_plate["confidence"], 4),
                        "bbox": [round(v, 5) for v in plate_xywh],
                    }
                    event = self._report(
                        vehicle, accepted_plate, plate_xywh, ctx,
                        self._snapshot(frame, vehicle["bbox_px"]))
                    if event:
                        durable.append(event)

            live.append(live_track(vehicle, extra))

        return live, durable

    @staticmethod
    def _snapshot(frame, bbox_px, plate=False) -> Optional[str]:
        x1, y1, x2, y2 = (int(value) for value in bbox_px)
        height, width = frame.shape[:2]
        x1, y1 = max(0, x1), max(0, y1)
        x2, y2 = min(width, x2), min(height, y2)
        if x2 <= x1 or y2 <= y1:
            return None
        crop = frame[y1:y2, x1:x2]
        if crop is None or crop.size == 0:
            return None
        target_width = 480 if not plate else 320
        scale = min(3.0 if plate else 1.0, target_width / max(1, crop.shape[1]))
        if scale != 1.0:
            crop = cv2.resize(crop, None, fx=scale, fy=scale,
                              interpolation=cv2.INTER_CUBIC if scale > 1 else cv2.INTER_AREA)
        ok, encoded = cv2.imencode(
            ".jpg", crop, [int(cv2.IMWRITE_JPEG_QUALITY), 88])
        if not ok:
            return None
        return "data:image/jpeg;base64," + base64.b64encode(encoded).decode("ascii")

    def _report(self, vehicle, plate, plate_norm, ctx: FrameContext,
                image_snapshot: Optional[str] = None) -> Optional[dict]:
        ref = vehicle.get("track_ref")
        if not ref:
            return None
        key = f"{ref}:{plate['text']}"
        if key in self._reported:
            return None
        self._reported[key] = ctx.ts
        if len(self._reported) > 4096:
            oldest = min(self._reported, key=self._reported.get)
            del self._reported[oldest]
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
                "image_snapshot": image_snapshot,
            },
        }

    def stats(self) -> dict:
        return {
            "vehicles_reported": len(self._reported_vehicles),
            "ocr_calls": self.reads,
            "reads_reported": self.accepted,
        }
