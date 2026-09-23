"""
Local human detection and tracking over HTTP, for the console's People page.

The people equivalent of ai_service.py, and deliberately its own file rather
than a second endpoint bolted onto it -- the same reason people_run.py and
run.py stayed apart from the start (see ibvap/README.md): a shared entry
point between the two domains is how one got its detector silently swapped
for the other's. This file imports nothing ANPR-specific, and ai_service.py
imports nothing from here.

REQUEST/RESPONSE, same shape as ai_service.py's /detect and for the same
reason: this is a frame the browser hands over (an uploaded clip or a
webcam capture), not a camera this process is watching on its own. There is
no zone to judge, no durable event to produce -- an operator scanning an
uploaded clip is looking at it, not building an audit trail.

TRACKING ACROSS REQUESTS WORKS THE SAME WAY THE VEHICLE SCANNER'S DOES: the
detector and the multi_human module are built ONCE (`@lru_cache`) and reused
for every /detect call, so ByteTrack's `persist=True` state and multi_human's
own `person_id` bookkeeping carry across the browser's polling requests
exactly as they would across frames of a live camera -- paced by
`setInterval` instead of an RTSP feed, but the same underlying state.

TARGET SEARCH (POST /target): an operator uploads a reference photo of one
person -- a still, not a track -- and every subsequent /detect call scores
every detected person against it. This is the SAME HistogramReID colour
signature `modules/reid.py` already uses for multi_human's own identities,
compared once per person per frame rather than folded into the gallery: a
reference photo is a one-off query, not a track this process has watched
build up its own history, so it never enters multi_human's own bookkeeping.

THE NAMING RULE APPLIES HERE JUST AS MUCH AS IT DOES TO multi_human's "P<n>"
labels (see reid.py): a `target_score` is how closely a crop's CLOTHING
COLOUR matches the reference photo's, not a recognition result. Two people
in similar clothing will both score high, and the console must show the
score, never a bare "found" flag, so an operator can judge it rather than
trust it blindly.

Launch from THIS directory (it imports core/ and modules/ as siblings):
    python -m uvicorn people_ai_service:app --host 127.0.0.1 --port 8002

STATUS: prototype.
"""

import base64
import time

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from core.detection import SharedDetector
from modules.base import FrameContext, build
from modules.reid import HistogramReID, cosine

# Registers "multi_human" in modules.base.REGISTRY. Only this one module is
# imported -- this service has no reason to load fence/anpr/face alongside it.
import modules.multi_human  # noqa: E402,F401

app = FastAPI(title="SeemaDrishti local people tracking")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["POST", "GET"],
    allow_headers=["content-type"],
)


class Frame(BaseModel):
    image: str


class _Models:
    """
    One shared detector and one shared multi_human module for the process's
    lifetime -- not per request. A fresh module per call would mint a new
    identity for every single detection, since multi_human's whole design
    (pending confirmation, appearance matching, trails) depends on state that
    persists across calls. `frame_index` is process-global for the same
    reason: it paces multi_human's embed_every / PENDING_FRAMES cadence the
    same way main.py's per-camera counter does.
    """

    def __init__(self):
        # Person only -- this endpoint has nothing to say about vehicles.
        self.detector = SharedDetector(classes=[0], run_id="scan-people")
        self.multi_human = build("multi_human", "scan-people", {})
        self.frame_index = 0
        # Set by POST /target. None means "not searching for anyone" -- every
        # /detect call skips the extra scoring pass entirely in that state.
        self.target_reid = HistogramReID()
        self.target_embedding: list[float] | None = None


_models: _Models | None = None


def models() -> _Models:
    global _models
    if _models is None:
        _models = _Models()
    return _models


def decode(data_url: str) -> np.ndarray:
    try:
        encoded = data_url.split(",", 1)[1] if "," in data_url else data_url
        image = cv2.imdecode(np.frombuffer(base64.b64decode(encoded), np.uint8),
                             cv2.IMREAD_COLOR)
    except Exception as exc:
        raise HTTPException(400, "invalid image frame") from exc
    if image is None:
        raise HTTPException(400, "could not decode image frame")
    return image


@app.get("/health")
def health():
    return {"ok": True, "service": "local-people-tracking"}


@app.post("/target")
def set_target(frame: Frame):
    """
    Take a reference photo -- an operator's upload, ideally one person filling
    most of the frame -- and remember their appearance signature for every
    subsequent /detect call to score against.

    The MOST CONFIDENT person detected in the photo is used, not necessarily
    the only one: a photo with a bystander in the background still works, but
    a crowded photo is a bad reference photo and the operator should be told
    so by a low confidence number, not a silent wrong pick.
    """
    image = decode(frame.image)
    state = models()
    people = [d for d in state.detector.detect(image) if d.get("is_person")]
    if not people:
        raise HTTPException(400, "no person found in the reference photo")
    subject = max(people, key=lambda p: p["confidence"])
    embedding = state.target_reid.embed(image, subject["bbox_px"])
    if embedding is None:
        raise HTTPException(400, "could not read an appearance signature from the reference photo")
    state.target_embedding = embedding
    return {"ok": True, "confidence": round(float(subject["confidence"]), 3)}


@app.delete("/target")
def clear_target():
    """Back to plain tracking -- every /detect call stops scoring against anyone."""
    state = models()
    state.target_embedding = None
    return {"ok": True}


@app.post("/detect")
def detect(frame: Frame):
    image = decode(frame.image)
    height, width = image.shape[:2]
    state = models()

    state.frame_index += 1
    detections = state.detector.detect(image)
    ctx = FrameContext(camera_id="scan-people", ts=time.monotonic(),
                       width=width, height=height, frame_index=state.frame_index)
    live, _durable = state.multi_human.process(image, detections, ctx)

    if state.target_embedding is not None:
        # Scored against the CURRENT crop, not multi_human's own gallery: a
        # target search is a one-off comparison against an operator-supplied
        # photo, and must never quietly become part of the ongoing identity
        # bookkeeping every track otherwise shares.
        by_ref = {d["track_ref"]: d for d in detections if d.get("track_ref")}
        for track in live:
            det = by_ref.get(track["extra"].get("track_ref"))
            if det is None:
                continue
            embedding = state.target_reid.embed(image, det["bbox_px"])
            track["extra"]["target_score"] = (
                round(cosine(embedding, state.target_embedding), 4)
                if embedding is not None else None
            )

    # Already the exact shape core/payload.py's live_track() builds for the
    # vision service's own WS channel -- one producer, one shape, same as
    # main.py's LiveObservation. No second JSON convention to keep in sync.
    return {"tracks": live}


@app.post("/reset")
def reset():
    """
    Discard TRACKING state -- not the target search. The console calls this
    when an operator loads a NEW clip: without it, a fresh video's first
    frame would be compared against identities left over from whatever was
    scanned before it, and a stranger in the new clip could be folded into an
    old "P3" from a video that has nothing to do with them.

    The reference photo is deliberately NOT cleared here: the whole point of
    a target search is finding the SAME person across DIFFERENT footage, so
    loading a second clip while still looking for them is the expected case,
    not a reason to forget who the operator uploaded a photo of. Call
    DELETE /target explicitly to end a search.
    """
    state = models()
    state.multi_human = build("multi_human", "scan-people", {})
    state.frame_index = 0
    return {"ok": True}
