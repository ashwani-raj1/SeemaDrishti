"""
Local human detection and tracking over HTTP, for the console's People page.

The people equivalent of ai_service.py, and deliberately its own file rather
than a second endpoint bolted onto it -- the same reason people_run.py and
run.py stayed apart from the start (see vision-service/README.md): a shared entry
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

WATCHLIST (POST /watchlist): a target search's persistent, NAMED sibling.
Where /target holds one unnamed reference photo for one session, the
watchlist holds any number of NAMED entries that persist until explicitly
removed, and every /detect call checks every tracked person against all of
them. Each entry carries up to two signals, both extracted once at
enrolment:

    face        modules/face.py's FaceEmbedder (SFace) -- genuinely
                identity-discriminative when a face is actually visible.
                See modules/face.py's own docstring for what has and has
                not been verified about it.
    appearance  the SAME HistogramReID colour signature /target uses --
                the fallback for when no face was detected in the
                enrolment photo, or in the current frame being scored.

A match prefers the face signal when both a live face and an enrolled face
embedding exist, because it is the stronger evidence; it falls back to
clothing colour otherwise. Never silently "recognition" either way --
`extra.watchlist_match` always carries a `signal` field naming which one
fired, so the console can show an operator the difference between "this is
probably them, by their face" and "this is probably them, by their shirt".

Launch from THIS directory (it imports core/ and modules/ as siblings):
    python -m uvicorn people_ai_service:app --host 127.0.0.1 --port 8002

STATUS: prototype.
"""

import base64
import json
import time
import urllib.error
import urllib.request

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from config import Settings
from core.detection import SharedDetector
from modules.base import FrameContext, build
from modules.face import DEFAULT_MODEL as FACE_DETECT_MODEL
from modules.face import DEFAULT_RECOGNITION_MODEL, FaceDetector, FaceEmbedder
from modules.reid import HistogramReID, cosine
from modules.watchlist_client import WatchlistClient

# Registers "multi_human" in modules.base.REGISTRY. Only this one module is
# imported -- this service has no reason to load fence/anpr alongside it.
import modules.multi_human  # noqa: E402,F401

#: A head sits near the top of a standing, sitting or crouching subject
#: alike -- same reasoning modules/face.py's own FaceModule uses.
FACE_SEARCH_UPPER_FRAC = 0.55

app = FastAPI(title="SeemaDrishti local people tracking")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:3001", "http://127.0.0.1:3001"],
    allow_methods=["POST", "GET", "DELETE"],
    allow_headers=["content-type"],
)


class Frame(BaseModel):
    image: str


class WatchlistEntry(BaseModel):
    name: str
    image: str
    # All three MOCK -- see backend/src/db/schema.sql's own note on
    # address/owned_plates/govt_id. Optional so the People page's existing
    # simple enrol flow (name + photo only) keeps working unchanged.
    address: str | None = None
    owned_plates: list[str] | None = None
    govt_id: str | None = None


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
        # Shared by /target's optional face boost and the watchlist -- one
        # detector/embedder pair, not one per feature.
        self.face_detector = FaceDetector(FACE_DETECT_MODEL)
        self.face_embedder = FaceEmbedder(DEFAULT_RECOGNITION_MODEL)
        # The backend now owns the watchlist (see modules/watchlist_client.py
        # and backend/src/l3/person_watchlist.ts) -- this process is a client
        # of it, the same as vision-service/main.py's live camera pipeline is, so an
        # entry enrolled from the People page's Upload/Live-webcam mode is
        # also matched against on every real camera, and vice versa. Persists
        # across /reset on purpose -- see /reset's own docstring.
        settings = Settings()
        self.watchlist = WatchlistClient(
            settings.backend_url, refresh_seconds=settings.watchlist_refresh_seconds,
        )


def _face_signature(state: _Models, image, bbox_px) -> tuple[list[float] | None, float | None]:
    """
    Search the upper fraction of a person's box for a face and, if one is
    found, embed it. Returns (embedding, detection_score) or (None, None).

    Shared between enrolment (POST /watchlist) and per-frame scoring
    (/detect) so the two never drift into finding a face two different ways.
    """
    x1, y1, x2, y2 = bbox_px
    y_cut = y1 + int((y2 - y1) * FACE_SEARCH_UPPER_FRAC)
    crop = image[y1:y_cut, x1:x2]
    if crop.size == 0:
        return None, None
    try:
        faces = state.face_detector.detect(crop)
    except FileNotFoundError:
        return None, None
    if not faces:
        return None, None
    best = max(faces, key=lambda f: f["score"])
    embedding = state.face_embedder.embed(crop, best["raw"])
    return embedding, best["score"]


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
    _push_target(state, embedding)
    return {"ok": True, "confidence": round(float(subject["confidence"]), 3)}


def _push_target(state: _Models, embedding: list[float] | None) -> None:
    """
    Relay the target embedding to the backend (backend/src/l3/target.ts) so
    vision-service/main.py's live camera pipeline can compare against it too --
    otherwise a target set from the People page's Upload/Live-webcam mode
    would stay invisible to the real "Cameras" source, the same gap
    modules/watchlist_client.py already closed for the watchlist. Best
    effort: a target that fails to push still works for THIS process's own
    /detect calls, it just will not reach the live cameras until the next
    successful push.
    """
    body = json.dumps({"appearanceEmbedding": embedding}).encode("utf-8")
    request = urllib.request.Request(
        f"{state.watchlist.backend_url}/api/target", data=body, method="POST",
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=3.0) as response:
            response.read()
    except (urllib.error.URLError, OSError) as error:
        print(f"[target] could not push to {state.watchlist.backend_url}/api/target: {error}")


def _clear_target_backend(state: _Models) -> None:
    request = urllib.request.Request(
        f"{state.watchlist.backend_url}/api/target", method="DELETE",
    )
    try:
        with urllib.request.urlopen(request, timeout=3.0) as response:
            response.read()
    except (urllib.error.URLError, OSError) as error:
        print(f"[target] could not clear {state.watchlist.backend_url}/api/target: {error}")


@app.post("/identify")
def identify(frame: Frame):
    """
    "Who is this" for the person dossier page: take a photo, find the most
    confident person in it, extract both signals and ask the SAME
    WatchlistClient.match() the live pipeline uses "does this match anyone
    already enrolled". Read-only -- this never enrols or remembers anything,
    it only answers the one question the dossier page's photo-search needs.

    A watchlist entry's NAME is the join key into the dossier (backend's
    GET /api/watchlist/people/{name}/dossier), so this is deliberately the
    smallest possible response: enough to look someone up, nothing the
    caller could mistake for the dossier itself.
    """
    image = decode(frame.image)
    state = models()
    people = [d for d in state.detector.detect(image) if d.get("is_person")]
    if not people:
        raise HTTPException(400, "no person found in the photo")
    subject = max(people, key=lambda p: p["confidence"])

    face_embedding, _ = _face_signature(state, image, subject["bbox_px"])
    appearance_embedding = state.target_reid.embed(image, subject["bbox_px"])
    match = state.watchlist.match(face_embedding, appearance_embedding)
    if not match:
        return {"matched": False}
    return {
        "matched": True,
        "name": match["name"],
        "score": round(match["score"], 4),
        "signal": match["signal"],
    }


@app.delete("/target")
def clear_target():
    """Back to plain tracking -- every /detect call stops scoring against anyone."""
    state = models()
    state.target_embedding = None
    _clear_target_backend(state)
    return {"ok": True}


@app.post("/watchlist")
def enroll_watchlist(entry: WatchlistEntry):
    """
    Enrol a NAMED person: extract whichever signals the photo actually
    supports (a face if one is visible, clothing colour always, as long as a
    person was found at all) and remember them under `entry.name`,
    overwriting any earlier entry with the same name.

    Enrolling with NEITHER signal extractable is refused rather than stored
    as an empty entry that could never match anything -- a name with nothing
    behind it would look like a working watchlist entry until an operator
    discovered otherwise, at the worst possible moment.
    """
    image = decode(entry.image)
    state = models()
    people = [d for d in state.detector.detect(image) if d.get("is_person")]
    if not people:
        raise HTTPException(400, "no person found in the photo")
    subject = max(people, key=lambda p: p["confidence"])

    appearance = state.target_reid.embed(image, subject["bbox_px"])
    face, face_score = _face_signature(state, image, subject["bbox_px"])

    if appearance is None and face is None:
        raise HTTPException(400, "could not extract any appearance or face signature from the photo")

    try:
        state.watchlist.enroll(
            entry.name, face_embedding=face, appearance_embedding=appearance,
            address=entry.address, owned_plates=entry.owned_plates, govt_id=entry.govt_id,
        )
    except (urllib.error.URLError, OSError) as error:
        raise HTTPException(502, f"could not reach the edge node to store this entry: {error}") from error
    return {
        "ok": True,
        "person_confidence": round(float(subject["confidence"]), 3),
        "face_detected": face is not None,
        "face_confidence": round(face_score, 3) if face_score is not None else None,
    }


@app.get("/watchlist")
def list_watchlist():
    state = models()
    return {"entries": [
        {"name": entry["name"], "has_face": bool(entry.get("face_embedding")),
         "has_appearance": bool(entry.get("appearance_embedding"))}
        for entry in state.watchlist.entries()
    ]}


@app.delete("/watchlist/{name}")
def remove_watchlist(name: str):
    state = models()
    try:
        state.watchlist.remove(name)
    except (urllib.error.URLError, OSError) as error:
        raise HTTPException(502, f"could not reach the edge node to remove this entry: {error}") from error
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

    if state.watchlist.entries():
        # Face computed at most ONCE per track per frame; matching itself is
        # delegated to modules/watchlist_client.py's WatchlistClient.match()
        # -- the exact same function vision-service/main.py's live camera pipeline
        # calls, so this ad-hoc endpoint and a real camera can never drift
        # into scoring a match two different ways.
        by_ref = {d["track_ref"]: d for d in detections if d.get("track_ref")}
        for track in live:
            det = by_ref.get(track["extra"].get("track_ref"))
            if det is None:
                continue
            face_embedding, _ = _face_signature(state, image, det["bbox_px"])
            appearance_embedding = state.target_reid.embed(image, det["bbox_px"])
            match = state.watchlist.match(face_embedding, appearance_embedding)
            track["extra"]["watchlist_match"] = (
                {"name": match["name"], "score": round(match["score"], 4), "signal": match["signal"]}
                if match else None
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

    The reference photo AND the watchlist are deliberately NOT cleared here:
    the whole point of either is finding the SAME person(s) across DIFFERENT
    footage, so loading a second clip while still looking is the expected
    case, not a reason to forget who the operator is watching for. Call
    DELETE /target, or DELETE /watchlist/{name}, to end a search explicitly.
    """
    state = models()
    state.multi_human = build("multi_human", "scan-people", {})
    state.frame_index = 0
    return {"ok": True}
