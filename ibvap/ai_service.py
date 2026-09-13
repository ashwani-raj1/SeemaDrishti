"""
Local vehicle detection and ANPR over HTTP, for the console's plate scanner.

A separate surface from the vision service on purpose: this one is REQUEST/
RESPONSE against a frame the browser hands over (a webcam capture or a file the
operator dropped in), not a camera the service is watching. There is no track
to follow across frames, no zone to judge against, and nothing durable is
produced — the console decides what to do with a read and posts it to the node
itself.

It reuses the same detector and the same plate reader as the service, so a
plate the scanner accepts is a plate the pipeline would have accepted. Two OCR
implementations that drift apart is how "it worked in the scanner" becomes an
unanswerable bug report.

Runs entirely on the operator's machine. No demo plates are ever invented: what
comes back was read from the pixels that arrived, or nothing comes back.

Launch from THIS directory (it imports core/ and modules/ as siblings):
    python -m uvicorn ai_service:app --host 127.0.0.1 --port 8001

STATUS: prototype.
"""

import base64
import math
import time
from functools import lru_cache

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from core.detection import SharedDetector
from modules.anpr import PlateReader

app = FastAPI(title="SeemaDrishti local ANPR")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["POST", "GET"],
    allow_headers=["content-type"],
)

#: OCR is far slower than YOLO. A plate is re-read only this often per vehicle;
#: every vehicle still gets a box on every frame.
OCR_INTERVAL_SECONDS = 4.0

STABLE_TRACKS: dict[str, dict] = {}
NEXT_STABLE_TRACK = 1


class Frame(BaseModel):
    image: str


@lru_cache(maxsize=1)
def models() -> tuple[SharedDetector, PlateReader]:
    # First start downloads the public YOLO weights and OCR language files.
    # Vehicles only here: the scanner is pointed at a car, and detecting
    # everything else would just add boxes an operator did not ask for.
    return (
        SharedDetector(classes=[2, 3, 5, 7], run_id="scan"),
        PlateReader(read_interval=OCR_INTERVAL_SECONDS),
    )


def iou(a, b) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    inter_w = max(0, min(ax2, bx2) - max(ax1, bx1))
    inter_h = max(0, min(ay2, by2) - max(ay1, by1))
    inter = inter_w * inter_h
    union = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter
    return inter / union if union else 0.0


def stable_track_key(vehicle: dict, width: int, height: int, assigned: set[str]) -> str:
    """
    Keep one browser-facing id when ByteTrack briefly drops and reissues one.

    THIS IS NOT RE-IDENTIFICATION and must never be described as one. It is a
    geometric heuristic — IoU plus normalised centre distance — scoped to one
    scanner session, so the UI can count a vehicle once instead of five times.
    It carries no appearance model and knows nothing about who is driving.
    """
    global NEXT_STABLE_TRACK
    now = time.monotonic()
    bbox = vehicle["bbox_px"]
    kind = vehicle["subtype"]
    x1, y1, x2, y2 = bbox
    centre = ((x1 + x2) / 2, (y1 + y2) / 2)

    best_key, best_score = None, float("-inf")
    for key, previous in STABLE_TRACKS.items():
        if key in assigned or previous["kind"] != kind or now - previous["seen"] > 8.0:
            continue
        px1, py1, px2, py2 = previous["bbox"]
        previous_centre = ((px1 + px2) / 2, (py1 + py2) / 2)
        distance = math.hypot(
            (centre[0] - previous_centre[0]) / max(1, width),
            (centre[1] - previous_centre[1]) / max(1, height),
        )
        overlap = iou(bbox, previous["bbox"])
        # A car driving toward the camera changes area drastically between
        # scans, where IoU alone goes to near zero. Its centre still follows the
        # same lane, so use both signals and reject only implausibly far
        # candidates. `assigned` keeps two visible cars apart.
        if distance > 0.55 and overlap < 0.02:
            continue
        score = overlap * 2.0 + (1.0 - min(distance, 1.0))
        if score > best_score:
            best_key, best_score = key, score

    if best_key is None:
        best_key = f"v{NEXT_STABLE_TRACK}"
        NEXT_STABLE_TRACK += 1

    STABLE_TRACKS[best_key] = {"kind": kind, "bbox": bbox, "seen": now}
    assigned.add(best_key)
    for key in [k for k, v in STABLE_TRACKS.items() if now - v["seen"] > 15.0]:
        del STABLE_TRACKS[key]
    return best_key


def decode(data_url: str) -> np.ndarray:
    try:
        encoded = data_url.split(",", 1)[1] if "," in data_url else data_url
        image = cv2.imdecode(np.frombuffer(base64.b64decode(encoded), np.uint8),
                             cv2.IMREAD_COLOR)
    except Exception as exc:
        raise HTTPException(400, "invalid image frame") from exc
    if image is None:
        raise HTTPException(400, "invalid image frame")
    return image


@app.get("/health")
def health():
    return {"ok": True, "service": "local-yolo-easyocr"}


@app.post("/detect")
def detect(frame: Frame):
    image = decode(frame.image)
    height, width = image.shape[:2]
    detector, plates = models()

    results = []
    assigned: set[str] = set()

    for vehicle in detector.detect(image):
        stable_key = stable_track_key(vehicle, width, height, assigned)
        plate = plates.read(image, vehicle["bbox_px"], cache_key=stable_key)

        results.append({
            # Browser frames arrive as independent HTTP requests, but ByteTrack
            # keeps this id while the same vehicle stays visible.
            "track_id": vehicle.get("track_id"),
            "track_key": stable_key,
            "vehicle_type": vehicle["subtype"],
            "confidence": round(float(vehicle["confidence"]), 3),
            "bbox": [round(v, 5) for v in vehicle["bbox"]],
            "plate": None if not plate else {
                "text": plate["text"],
                "confidence": round(float(plate["confidence"]), 3),
                "bbox": [
                    round(plate["bbox"][0] / width, 5),
                    round(plate["bbox"][1] / height, 5),
                    round(plate["bbox"][2] / width, 5),
                    round(plate["bbox"][3] / height, 5),
                ],
            },
        })

    return {"detections": results}
