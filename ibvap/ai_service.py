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
import json
import math
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import Future, ThreadPoolExecutor
from functools import lru_cache

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from core.detection import SharedDetector
from config import load_env
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
OCR_INTERVAL_SECONDS = 3.0
# A vehicle is often unreadable when first seen far away, then clear a few
# seconds later. Waiting thirty seconds cached that first UNKNOWN for almost
# the whole pass. Successful answers remain cached; only UNKNOWN retries.
LLM_RETRY_SECONDS = 4.0

STABLE_TRACKS: dict[str, dict] = {}
NEXT_STABLE_TRACK = 1
LLM_READS: dict[str, dict] = {}
LLM_JOBS: dict[str, Future] = {}
# Gemini/OpenAI are network fallbacks. They must never hold the /detect request
# open, otherwise one slow API response freezes YOLO, OCR, and vehicle counts.
LLM_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="anpr-ai")


def _llm_retry_needed(cached: dict | None, vehicle_area: int,
                      now: float) -> bool:
    if not cached:
        return True
    age = now - cached["attempted"]
    previous_area = max(1, cached.get("vehicle_area", 1))
    materially_clearer = vehicle_area >= previous_area * 1.35
    retry_after = 12.0 if cached.get("result") else LLM_RETRY_SECONDS
    return materially_clearer or age >= retry_after


def llm_settings() -> tuple[str, str, bool]:
    env = load_env()
    api_key = os.getenv("OPENAI_API_KEY") or env.get("OPENAI_API_KEY", "")
    model = os.getenv("OPENAI_VISION_MODEL") or env.get(
        "OPENAI_VISION_MODEL", "gpt-5.6-luna")
    enabled = env.get("IBVAP_LLM_PLATE_FALLBACK", "true").lower() in {
        "1", "true", "yes", "on"
    }
    return api_key, model, enabled


def gemini_settings() -> tuple[str, str]:
    env = load_env()
    api_key = (os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
               or env.get("GEMINI_API_KEY", "") or env.get("GOOGLE_API_KEY", ""))
    model = os.getenv("GEMINI_VISION_MODEL") or env.get(
        "GEMINI_VISION_MODEL", "gemini-2.5-flash-lite")
    return api_key, model


class Frame(BaseModel):
    image: str


@lru_cache(maxsize=1)
def models() -> tuple[SharedDetector, PlateReader]:
    # First start downloads the public YOLO weights and OCR language files.
    # Vehicles only here: the scanner is pointed at a car, and detecting
    # everything else would just add boxes an operator did not ask for.
    return (
        # Shared-camera vehicles can be small while approaching the gate.
        # A larger inference image and slightly lower threshold recover those
        # vehicles without enabling any non-vehicle COCO classes.
        SharedDetector(
            classes=[2, 3, 5, 7],
            run_id="scan",
            imgsz=640,
            conf=0.20,
        ),
        PlateReader(
            ocr_confidence=0.20,
            read_interval=OCR_INTERVAL_SECONDS,
        ),
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
    raw_track_id = vehicle.get("track_id")
    x1, y1, x2, y2 = bbox
    centre = ((x1 + x2) / 2, (y1 + y2) / 2)

    best_key, best_score = None, float("-inf")
    for key, previous in STABLE_TRACKS.items():
        age = now - previous["seen"]
        # CPU EasyOCR can make the next browser request arrive more than three
        # seconds later. Keep the geometric track alive long enough for that
        # response and for the asynchronous Gemini hint to be collected.
        if key in assigned or previous["kind"] != kind or age > 8.0:
            continue
        px1, py1, px2, py2 = previous["bbox"]
        previous_centre = ((px1 + px2) / 2, (py1 + py2) / 2)
        distance = math.hypot(
            (centre[0] - previous_centre[0]) / max(1, width),
            (centre[1] - previous_centre[1]) / max(1, height),
        )
        overlap = iou(bbox, previous["bbox"])
        previous_raw_id = previous.get("raw_track_id")
        same_raw_track = raw_track_id is not None and previous_raw_id == raw_track_id
        # A different ByteTrack id is normally a different vehicle. Permit a
        # merge only across a very brief detector dropout and only when the
        # boxes are still almost in the same place. The old eight-second pure
        # geometry window merged consecutive cars travelling in one lane.
        if (raw_track_id is not None and previous_raw_id is not None
                and not same_raw_track
                and (age > 1.5 or (overlap < 0.35 and distance > 0.08))):
            continue
        # A car driving toward the camera changes area drastically between
        # scans, where IoU alone goes to near zero. Its centre still follows the
        # same lane, so use both signals and reject only implausibly far
        # candidates. `assigned` keeps two visible cars apart.
        if distance > 0.55 and overlap < 0.02:
            continue
        score = (10.0 if same_raw_track else 0.0) + overlap * 2.0 + (1.0 - min(distance, 1.0))
        if score > best_score:
            best_key, best_score = key, score

    if best_key is None:
        best_key = f"v{NEXT_STABLE_TRACK}"
        NEXT_STABLE_TRACK += 1

    STABLE_TRACKS[best_key] = {
        "kind": kind,
        "bbox": bbox,
        "seen": now,
        "raw_track_id": raw_track_id,
    }
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


def _response_text(payload: dict) -> str:
    if isinstance(payload.get("output_text"), str):
        return payload["output_text"]
    for item in payload.get("output", []):
        if item.get("type") != "message":
            continue
        for content in item.get("content", []):
            if content.get("type") == "output_text":
                return str(content.get("text", ""))
    return ""


def _parse_vision_answer(answer: str) -> tuple[str, str]:
    """Return a conservative (plate, vehicle type) pair from model output."""
    cleaned = answer.strip().replace("```json", "").replace("```", "").strip()
    plate = ""
    vehicle_type = ""
    try:
        payload = json.loads(cleaned)
        plate = str(payload.get("plate", ""))
        vehicle_type = str(payload.get("vehicle_type", ""))
    except (json.JSONDecodeError, AttributeError):
        # Compatibility with a provider returning the old plate-only format.
        plate = cleaned

    plate = re.sub(r"[^A-Z0-9]", "", plate.upper())
    vehicle_type = re.sub(r"[^a-z]", "", vehicle_type.lower())
    if vehicle_type not in {"car", "motorcycle", "bus", "truck"}:
        vehicle_type = ""
    return plate, vehicle_type


def llm_plate_fallback(image: np.ndarray, vehicle_bbox, track_key: str,
                       reader: PlateReader) -> dict | None:
    """Ask a vision model once when local OCR cannot read a tracked plate.

    This is deliberately an UNVERIFIED operator hint. It must not create a
    watchlist hit or durable detection without local OCR/operator confirmation.
    Only the lower-centre plate region is uploaded, never the video/frame.
    """
    openai_key, openai_model, enabled = llm_settings()
    gemini_key, gemini_model = gemini_settings()
    if not enabled or not (openai_key or gemini_key):
        return None

    now = time.monotonic()
    x1, y1, x2, y2 = vehicle_bbox
    vehicle_area = max(1, (x2 - x1) * (y2 - y1))
    cached = LLM_READS.get(track_key)
    if not _llm_retry_needed(cached, vehicle_area, now):
        return cached.get("result") if cached else None

    px1, py1, px2, py2 = reader.plate_region(vehicle_bbox, image.shape,
                                              lower_frac=0.32,
                                              center_w_frac=0.72)
    crop = image[py1:py2, px1:px2]
    if crop is None or crop.size == 0 or crop.shape[1] < 24 or crop.shape[0] < 12:
        LLM_READS[track_key] = {
            "attempted": now, "vehicle_area": vehicle_area, "result": None}
        return None

    scale = max(4.0, min(8.0, 200.0 / max(1, crop.shape[0])))
    enlarged = cv2.resize(crop, None, fx=scale, fy=scale,
                          interpolation=cv2.INTER_CUBIC)
    # Recover dark characters around headlight glare before the free vision
    # fallback sees the crop. It still returns an explicitly unverified hint.
    luminance = cv2.cvtColor(enlarged, cv2.COLOR_BGR2LAB)
    l_channel, a_channel, b_channel = cv2.split(luminance)
    l_channel = cv2.createCLAHE(clipLimit=3.0,
                                tileGridSize=(8, 8)).apply(l_channel)
    enlarged = cv2.cvtColor(cv2.merge((l_channel, a_channel, b_channel)),
                            cv2.COLOR_LAB2BGR)
    ok, encoded = cv2.imencode(".jpg", enlarged,
                               [int(cv2.IMWRITE_JPEG_QUALITY), 90])
    if not ok:
        return None

    image_base64 = base64.b64encode(encoded).decode("ascii")
    vx1, vy1, vx2, vy2 = (int(value) for value in vehicle_bbox)
    vehicle_crop = image[max(0, vy1):max(0, vy2), max(0, vx1):max(0, vx2)]
    vehicle_base64 = ""
    if vehicle_crop is not None and vehicle_crop.size:
        vehicle_height, vehicle_width = vehicle_crop.shape[:2]
        vehicle_scale = min(1.0, 640.0 / max(vehicle_height, vehicle_width))
        if vehicle_scale < 1.0:
            vehicle_crop = cv2.resize(
                vehicle_crop, None, fx=vehicle_scale, fy=vehicle_scale,
                interpolation=cv2.INTER_AREA)
        vehicle_ok, vehicle_encoded = cv2.imencode(
            ".jpg", vehicle_crop, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
        if vehicle_ok:
            vehicle_base64 = base64.b64encode(vehicle_encoded).decode("ascii")
    prompt = (
        "The first image is an enhanced probable registration-plate crop and "
        "the second image is the complete detected vehicle for context. Read "
        "the plate and classify the vehicle. Return ONLY compact JSON exactly "
        "like {\"plate\":\"AB12CD3456\",\"vehicle_type\":\"car\"}. "
        "vehicle_type must be car, motorcycle, bus, truck, or unknown. Use "
        "UNKNOWN for plate when characters are not sufficiently visible. "
        "Never invent hidden characters."
    )
    env = load_env()
    preference = env.get("IBVAP_LLM_PROVIDER", "auto").strip().lower()
    providers = []
    if gemini_key and preference in {"auto", "gemini"}:
        providers.append(("gemini", gemini_model))
    if openai_key and preference in {"auto", "openai"}:
        providers.append(("openai", openai_model))

    answer = ""
    used_model = ""
    result = None
    for provider, model in providers:
        try:
            if provider == "gemini":
                parts = [{"inline_data": {
                    "mime_type": "image/jpeg", "data": image_base64}}]
                if vehicle_base64:
                    parts.append({"inline_data": {
                        "mime_type": "image/jpeg", "data": vehicle_base64}})
                parts.append({"text": prompt})
                body = json.dumps({
                    "contents": [{"parts": parts}],
                    "generationConfig": {
                        "temperature": 0,
                        "maxOutputTokens": 80,
                        "responseMimeType": "application/json",
                    },
                }).encode("utf-8")
                url = (
                    "https://generativelanguage.googleapis.com/v1beta/models/"
                    f"{urllib.parse.quote(model, safe='')}:generateContent"
                )
                request = urllib.request.Request(
                    url,
                    data=body,
                    headers={
                        "x-goog-api-key": gemini_key,
                        "Content-Type": "application/json",
                    },
                    method="POST",
                )
                with urllib.request.urlopen(request, timeout=12) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                answer = str(payload["candidates"][0]["content"]["parts"][0]["text"])
            else:
                data_url = "data:image/jpeg;base64," + image_base64
                content = [
                    {"type": "input_text", "text": prompt},
                    {"type": "input_image", "image_url": data_url, "detail": "high"},
                ]
                if vehicle_base64:
                    content.append({
                        "type": "input_image",
                        "image_url": "data:image/jpeg;base64," + vehicle_base64,
                        "detail": "high",
                    })
                body = json.dumps({
                    "model": model,
                    "store": False,
                    "max_output_tokens": 80,
                    "input": [{
                        "role": "user",
                        "content": content,
                    }],
                }).encode("utf-8")
                request = urllib.request.Request(
                    "https://api.openai.com/v1/responses",
                    data=body,
                    headers={
                        "Authorization": f"Bearer {openai_key}",
                        "Content-Type": "application/json",
                    },
                    method="POST",
                )
                with urllib.request.urlopen(request, timeout=12) as response:
                    answer = _response_text(json.loads(response.read().decode("utf-8")))
            used_model = model
            if answer:
                break
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError,
                KeyError, IndexError) as exc:
            print(f"[anpr] {provider} fallback unavailable: {exc}", flush=True)

    if answer:
        text, vehicle_type = _parse_vision_answer(answer)
        plausible = (
            6 <= len(text) <= 12
            and any(char.isalpha() for char in text)
            and any(char.isdigit() for char in text)
            and text != "UNKNOWN"
        )
        if plausible:
            result = {
                "text": text,
                # This is a display ranking, not calibrated OCR confidence.
                "confidence": 0.25,
                "bbox": (px1, py1, px2, py2),
                "source": "llm",
                "verified": False,
                "model": used_model,
                "vehicle_type": vehicle_type,
            }
        elif vehicle_type:
            # Gemini can still refine COCO's broad vehicle class even when the
            # registration characters are honestly unreadable. Keep that hint
            # separate from the plate result so the UI continues to show
            # "No plate read" instead of treating UNKNOWN as a registration.
            result = {
                "text": "",
                "confidence": 0.0,
                "bbox": (px1, py1, px2, py2),
                "source": "llm",
                "verified": False,
                "model": used_model,
                "vehicle_type": vehicle_type,
            }

    LLM_READS[track_key] = {
        "attempted": now,
        "vehicle_area": vehicle_area,
        "result": result,
    }
    if len(LLM_READS) > 512:
        oldest = min(LLM_READS, key=lambda key: LLM_READS[key]["attempted"])
        del LLM_READS[oldest]
    return result


def llm_plate_hint_nonblocking(image: np.ndarray, vehicle_bbox,
                               track_key: str, reader: PlateReader) -> dict | None:
    """Return the latest AI hint and refresh it without blocking detection."""
    job = LLM_JOBS.get(track_key)
    if job is not None and job.done():
        try:
            job.result()
        except Exception as exc:  # network/provider failures are non-fatal
            print(f"[anpr] AI fallback job failed: {exc}", flush=True)
        finally:
            LLM_JOBS.pop(track_key, None)
        job = None

    x1, y1, x2, y2 = vehicle_bbox
    vehicle_area = max(1, (x2 - x1) * (y2 - y1))
    cached = LLM_READS.get(track_key)
    if job is None and _llm_retry_needed(cached, vehicle_area, time.monotonic()):
        # The worker owns its frame copy. The next browser scan picks up its
        # cached answer; current-frame vehicle detection returns immediately.
        LLM_JOBS[track_key] = LLM_EXECUTOR.submit(
            llm_plate_fallback,
            image.copy(),
            tuple(vehicle_bbox),
            track_key,
            reader,
        )

    cached = LLM_READS.get(track_key)
    return cached.get("result") if cached else None


@app.get("/health")
def health():
    openai_key, openai_model, enabled = llm_settings()
    gemini_key, gemini_model = gemini_settings()
    provider = "gemini" if gemini_key else "openai" if openai_key else None
    model = gemini_model if provider == "gemini" else openai_model if provider else None
    return {
        "ok": True,
        "service": "local-yolo-easyocr",
        "llm_fallback": enabled and bool(provider),
        "llm_provider": provider,
        "llm_model": model if enabled else None,
    }


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
        ai_hint = None
        if not plate:
            ai_hint = llm_plate_hint_nonblocking(
                image, vehicle["bbox_px"], stable_key, plates)
            if ai_hint and ai_hint.get("text"):
                plate = ai_hint

        results.append({
            # Browser frames arrive as independent HTTP requests, but ByteTrack
            # keeps this id while the same vehicle stays visible.
            "track_id": vehicle.get("track_id"),
            "track_key": stable_key,
            "vehicle_type": (
                ai_hint.get("vehicle_type") if ai_hint and ai_hint.get("vehicle_type")
                else vehicle["subtype"]
            ),
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
                "source": plate.get("source", "ocr"),
                "verified": plate.get("verified", True),
                "model": plate.get("model"),
            },
        })

    return {"detections": results}
