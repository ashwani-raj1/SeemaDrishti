"""Local vehicle detection and ANPR service for SeemaDrishti.

Runs entirely on the operator's machine. It accepts a JPEG frame from the
browser, detects COCO vehicles with YOLO, reads plate text using EasyOCR, and
returns only results actually found in that frame. No demo plates are created.
"""

import base64
import re
import time
import math
from functools import lru_cache

import cv2
import easyocr
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from core.vehicle import VehicleTracker
from core.plate import PlateDetector

app = FastAPI(title="SeemaDrishti local ANPR")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["POST", "GET"],
    allow_headers=["content-type"],
)

PLATE_PATTERN = re.compile(r"^[A-Z0-9]{6,12}$")
OCR_INTERVAL_SECONDS = 4.0
# OCR is far slower than YOLO. Cache by the YOLO track ID so every vehicle
# still gets a box each frame, but its plate is re-read only periodically.
OCR_CACHE: dict[str, tuple[float, dict | None]] = {}
STABLE_TRACKS: dict[str, dict] = {}
NEXT_STABLE_TRACK = 1


def iou(a, b) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    inter_w, inter_h = max(0, min(ax2, bx2) - max(ax1, bx1)), max(0, min(ay2, by2) - max(ay1, by1))
    inter = inter_w * inter_h
    union = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter
    return inter / union if union else 0.0


def stable_track_key(vehicle: dict, frame_width: int, frame_height: int, assigned: set[str]) -> str:
    """Keep one browser-facing ID when ByteTrack briefly drops/reissues one."""
    global NEXT_STABLE_TRACK
    now = time.monotonic()
    bbox = vehicle["bbox"]
    kind = vehicle["class"]
    x1, y1, x2, y2 = bbox
    center = ((x1 + x2) / 2, (y1 + y2) / 2)
    best_key, best_score = None, float("-inf")
    for key, previous in STABLE_TRACKS.items():
        if key in assigned or previous["class"] != kind or now - previous["seen"] > 8.0:
            continue
        px1, py1, px2, py2 = previous["bbox"]
        previous_center = ((px1 + px2) / 2, (py1 + py2) / 2)
        distance = math.hypot(
            (center[0] - previous_center[0]) / max(1, frame_width),
            (center[1] - previous_center[1]) / max(1, frame_height),
        )
        overlap = iou(bbox, previous["bbox"])
        # A car driving toward a camera can change area drastically between
        # scans, where IoU alone becomes near zero. Its centre still follows
        # the same lane, so use both signals and reject only implausibly far
        # candidates. `assigned` keeps two visible cars separate.
        if distance > 0.55 and overlap < 0.02:
            continue
        score = overlap * 2.0 + (1.0 - min(distance, 1.0))
        if score > best_score:
            best_key, best_score = key, score
    if best_key is None:
        best_key = f"v{NEXT_STABLE_TRACK}"
        NEXT_STABLE_TRACK += 1
    STABLE_TRACKS[best_key] = {"class": kind, "bbox": bbox, "seen": now}
    assigned.add(best_key)
    for key in [key for key, value in STABLE_TRACKS.items() if now - value["seen"] > 15.0]:
        del STABLE_TRACKS[key]
    return best_key


class Frame(BaseModel):
    image: str


@lru_cache(maxsize=1)
def models():
    # First start downloads the public YOLO weights and OCR language files.
    return VehicleTracker(), PlateDetector(), easyocr.Reader(["en"], gpu=False)


def decode(data_url: str) -> np.ndarray:
    try:
        encoded = data_url.split(",", 1)[1] if "," in data_url else data_url
        image = cv2.imdecode(np.frombuffer(base64.b64decode(encoded), np.uint8), cv2.IMREAD_COLOR)
    except Exception as exc:
        raise HTTPException(400, "invalid image frame") from exc
    if image is None:
        raise HTTPException(400, "invalid image frame")
    return image


def normalise(raw: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", raw.upper())


@app.get("/health")
def health():
    return {"ok": True, "service": "local-yolo-easyocr"}


@app.post("/detect")
def detect(frame: Frame):
    image = decode(frame.image)
    height, width = image.shape[:2]
    tracker, plate_detector, reader = models()
    results = []
    assigned_tracks: set[str] = set()
    for vehicle in tracker.update(image):
        stable_key = stable_track_key(vehicle, width, height, assigned_tracks)
        x1, y1, x2, y2 = vehicle["bbox"]
        plate_box = plate_detector.plate_region((x1, y1, x2, y2), image.shape)
        px1, py1, px2, py2 = plate_box
        track_key = stable_key
        previous = OCR_CACHE.get(track_key)
        plate = previous[1] if previous and time.monotonic() - previous[0] < OCR_INTERVAL_SECONDS else None
        if (not previous or time.monotonic() - previous[0] >= OCR_INTERVAL_SECONDS) and px2 > px1 and py2 > py1:
            crop = image[py1:py2, px1:px2]
            # Small night-time plates need enlargement and contrast recovery
            # before OCR.  This remains an OCR result, not a guessed plate.
            crop = cv2.resize(crop, None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)
            gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
            gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
            readings = reader.readtext(gray, detail=1, allowlist="ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
            if readings:
                # OCR sometimes yields state, series and number as separate
                # tokens. Preserve their left-to-right order before validating.
                readings.sort(key=lambda item: min(point[0] for point in item[0]))
                text = normalise("".join(item[1] for item in readings))
                ocr_confidence = sum(float(item[2]) for item in readings) / len(readings)
                # A real plate must still be plausibly long and contain both
                # letters and digits; arbitrary scene text is rejected.
                if (ocr_confidence >= 0.45 and PLATE_PATTERN.match(text)
                        and any(c.isalpha() for c in text) and any(c.isdigit() for c in text)):
                    # EasyOCR gives text polygons on the enlarged crop. Turn
                    # them back into a tight plate rectangle in source-image
                    # pixels instead of falsely labelling the whole car body
                    # as the number plate.
                    points = [point for reading in readings for point in reading[0]]
                    rx1 = max(px1, px1 + int(min(point[0] for point in points) / 4))
                    ry1 = max(py1, py1 + int(min(point[1] for point in points) / 4))
                    rx2 = min(px2, px1 + int(max(point[0] for point in points) / 4))
                    ry2 = min(py2, py1 + int(max(point[1] for point in points) / 4))
                    # OCR polygons can be character-tight; give the saved
                    # plate image a small margin without including the car.
                    margin_x, margin_y = 8, 5
                    rx1, ry1 = max(px1, rx1 - margin_x), max(py1, ry1 - margin_y)
                    rx2, ry2 = min(px2, rx2 + margin_x), min(py2, ry2 + margin_y)
                    plate = {
                        "text": text,
                        "confidence": round(float(ocr_confidence), 3),
                        "bbox": [rx1 / width, ry1 / height, rx2 / width, ry2 / height],
                    }
            OCR_CACHE[track_key] = (time.monotonic(), plate)
        results.append({
            # Browser video frames arrive as independent HTTP requests, but
            # ByteTrack keeps this identifier while the same vehicle remains
            # visible. The UI uses it to count a vehicle once per session.
            "track_id": vehicle.get("track_id"),
            "track_key": stable_key,
            "vehicle_type": vehicle["class"],
            "confidence": round(float(vehicle["conf"]), 3),
            "bbox": [x1 / width, y1 / height, x2 / width, y2 / height],
            "plate": plate,
        })
    return {"detections": results}
