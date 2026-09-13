# Master Prompt: Vision Service for Surveillance Platform

## Context

You are building the **Vision Service** — the detection/intelligence layer of a surveillance application. This service is one part of a larger platform:

- **RTSP Server**: simulates/serves CCTV feeds (no physical cameras yet, synthetic feeds for now). Extensible so real cameras can be added later. Architecture inspired by Frigate.
- **Vision Service** (what you're building): a standalone Python process that consumes RTSP feeds and runs all detection logic.
- **Backend**: the durable system of record. Persists confirmed events/incidents, plate reads, camera health, evidence metadata, and all operator actions. Re-broadcasts persisted state to the frontend.
- **Frontend**: renders live feeds/overlays in real time, and issues operator actions (acknowledge, escalate, dismiss, edit zone, search history, change config) to the backend.

This is an MVP — favor working and pluggable over maximally robust/scaled. Decent FPS is enough; don't over-engineer for scale yet. That said, the contract below is designed to scale cleanly (more cameras, more modules, more frontend clients) without rework, so don't collapse it back into a single shared payload for convenience.

## Core architectural principle

**Vision Service owns realtime observation. Backend owns durable truth and operator decisions.**

Do not send all realtime data directly from Vision Service to the frontend and bypass the backend. Do not treat WS-to-frontend and POST-to-backend as two parallel fan-outs of one common payload — they carry *different kinds of data* with *different persistence guarantees*.

Three separate paths:

```
RTSP
  -> Vision Service
      +- WebSocket -> Frontend
      |              live video boxes, tracking state, transient/unconfirmed detections
      |
      +- HTTP (durable ingress) -> Backend
                     confirmed detections, confirmed alerts, plate reads,
                     camera health, evidence metadata

Frontend
  -> Backend
       operator actions: acknowledge, escalate, dismiss, edit zone,
       search history, change configuration

Backend
  -> Frontend (separate channel: SSE/WebSocket)
       persisted event/incident state, so the UI treats the backend,
       not a raw Vision Service message, as authoritative for anything durable
```

### Why this split, not one common shape

If Vision Service pushes a "confirmed intrusion" straight to the frontend over WS *and* POSTs it to the backend in parallel, a disconnected/slow frontend or a failed POST produces real problems: alerts visible live but missing from history, duplicate alerts on reconnect, operator actions taken against events that were never persisted, different frontend clients seeing different alert states, and no reliable audit trail. Splitting the contract in two avoids all of this by construction — nothing durable is ever "only in the frontend."

| Data | Owner | Persistence |
|---|---|---|
| Detector output (e.g. a box on frame 120) | Vision Service | Ephemeral |
| Current track trajectory | Vision Service | Ephemeral (optionally summarized) |
| Confirmed zone crossing / plate match | Backend | Durable |
| Operator acknowledge / escalate / dismiss | Backend | Durable and audited |
| Historical track/event record | Backend | Durable |

## Two output contracts (not one)

### 1. Live observation contract — Vision Service -> Frontend WebSocket

Ephemeral, low-latency, useful only while watching the live feed. Never written to the database. Safe to drop if the frontend is slow or disconnected — no delivery guarantees needed.

```python
{
  "camera_id": str,
  "module": str,            # "fence" | "anpr" | "multi_human"
  "kind": "live",
  "frame_ts": float,
  "tracks": [
    {
      "track_id": int,
      "bbox": [x1, y1, x2, y2],
      "confidence": float,
      "class": str,
      "extra": dict          # module-specific transient data, e.g. live plate OCR guess, trajectory points
    }
  ]
}
```

### 2. Durable event contract — Vision Service -> Backend (HTTP ingress)

Only confirmed, meaningful events: fence intrusions that passed debounce/cooldown, accepted plate reads, camera health changes. The backend validates, persists, creates/updates incidents, and is responsible for pushing the persisted result back to connected frontends on its own channel — the frontend must not treat a raw Vision Service message as authoritative for anything durable.

```python
{
  "camera_id": str,
  "module": str,             # "fence" | "anpr" | "multi_human"
  "event_type": str,         # e.g. "intrusion", "plate_read", "camera_health"
  "track_id": int | None,
  "data": dict,              # module-specific confirmed payload (zone name, plate text + confidence, etc.)
  "timestamp": float
}
```

### Operator actions never touch Vision Service

Acknowledge, escalate, dismiss, zone edits, configuration changes, and history searches are Frontend -> Backend only. Vision Service has no role in this path and should not receive or process operator commands.

## Core requirement: shared detection, pluggable modules

The Vision Service is **one long-running process** hosting **multiple pluggable detection sub-modules** (not separate services per capability). One detection pass (object detection + tracking) runs per frame; its results are handed to every active sub-module. Sub-modules must NOT each re-run their own full object detection independently.

### Sub-modules to support (pluggable, config-toggled per camera)

1. **Fence detection** — virtual fence / zone intrusion detection. Support both:
   - Zone/polygon intrusion (point-in-polygon test against a reference point, typically bottom-center/"feet" of a bounding box)
   - Line-crossing (side-of-line sign flip between frames for the same tracked ID)
   - Must debounce: require N consecutive confirming frames and a per-track cooldown before emitting a *durable* event. Per-frame box/track state can still stream live over WS while unconfirmed.

2. **ANPR (Automatic Number Plate Recognition)** — detect vehicles, crop plate region, run plate OCR/recognition, emit plate text + confidence. Crop from the general object detector's vehicle boxes and run OCR directly (e.g. EasyOCR or a lightweight plate-specific OCR step) rather than standing up a dedicated plate-detection model — simpler pipeline, one less model to maintain, accurate enough for an MVP. Live/unconfirmed OCR guesses can stream over WS; only accepted reads go to the backend as durable events.

3. **Multi-human follow-up** — support both:
   - **Within-camera persistent tracking** (tracker IDs from the shared detection pass, already available for free) as the baseline — this is what streams live over WS.
   - **Cross-camera / re-entry re-identification** via appearance embeddings (e.g. a lightweight ReID model run on the cropped person bounding box), used to match a track to a previously-seen identity when it reappears after leaving frame or moving to a different camera. Build within-camera tracking first; layer embedding-based re-ID on top as a second pass once that's working. Confirmed re-identifications (a returning known track) are durable events; ongoing trajectory is live-only.

Design the module system so **new sub-modules can be added later** (e.g. loitering detection, PPE compliance) without touching the WebSocket/HTTP dispatch layer.

## Required internal structure

```
vision_service/
├── main.py                 # entrypoint: starts capture loops, registers active modules, runs both dispatch paths
├── core/
│   ├── capture.py          # RTSPStream — threaded reader, always serves latest frame, auto-reconnect on drop
│   ├── detection.py        # shared object detection + tracking (single pass per frame, reused by all modules)
│   ├── payload.py          # LiveObservation and DurableEvent schemas + builders
│   └── dispatcher.py       # two sinks: WS fanout for LiveObservation, async HTTP POST for DurableEvent
├── modules/
│   ├── base.py             # VisionModule interface: process(frame, detections) -> (live: list[dict], durable: list[dict])
│   ├── fence.py            # fence/zone intrusion module
│   ├── anpr.py             # plate recognition module
│   └── multi_human.py      # multi-human tracking/follow-up module
└── config.py                # per-camera config: RTSP url, which modules are active + their params (zones, thresholds, etc.)
```

Each module's `process()` should return two separate lists — live/ephemeral items and durable/confirmed items — so the dispatcher never has to guess which channel a given event belongs on.

## Technical requirements

- **Object detection/tracking**: use `ultralytics` YOLO (start with `yolov8n` for speed) with built-in tracking (`model.track(persist=True)`) for one shared detection pass per frame.
- **RTSP capture**: threaded reader (`cv2.VideoCapture` in a background thread), always exposes the latest frame (don't let a slow consumer fall behind and process stale buffered frames), auto-reconnects on stream drop.
- **Detection cadence**: cap processing FPS (e.g. 5–10 fps) rather than running at full camera framerate — this keeps CPU/GPU load sane across multiple simultaneous camera streams. Live WS overlays can still feel smooth at this rate; don't over-fit cadence to 30fps expectations.
- **Dispatcher**:
  - WebSocket (live path): maintain a set of connected frontend clients, fan out each `LiveObservation` to all of them, drop dead connections gracefully. No retry, no persistence — if a client is gone, the data is gone, and that's fine.
  - HTTP (durable path): POST each `DurableEvent` to the backend asynchronously (don't let a slow/failing backend stall the detection loop); keep payload lean (avoid embedding large images on every event — only attach a snapshot on first alert per cooldown window if needed). Consider a small retry/backoff here since this path must not silently lose data the way the live path can.
- **Config-driven**: per-camera config defines RTSP URL and which modules are active with their params (e.g. fence zones as polygon coordinates, confirm-frame counts, cooldowns). Adding a camera or toggling a module should not require code changes. RTSP URLs and the backend's durable-ingress endpoint are supplied via a common `.env` file (already provided) — read them from there rather than hardcoding or prompting for them. No auth required on the backend ingress call.
- **Async runtime**: use `asyncio` for the main loop structure (one task per camera stream); if CPU-bound inference becomes a bottleneck across many camera processes, consider `multiprocessing` per camera instead — flag this tradeoff if you hit it, don't silently pick one without noting it.

## What to build first (suggested order)

1. `core/capture.py` — RTSPStream with threaded reader + reconnect logic
2. `core/detection.py` — shared YOLO detection+tracking wrapper, normalized detection output format
3. `core/payload.py` — `LiveObservation` and `DurableEvent` schemas
4. `modules/base.py` — VisionModule interface returning `(live, durable)` tuples
5. `modules/fence.py` — zone + line-crossing intrusion detection with debounce/cooldown, emitting live track state continuously and a durable event only on confirmed intrusion
6. `core/dispatcher.py` — WS fanout for live, async POST (with basic retry) for durable
7. `main.py` — wire capture → detection → active modules → both dispatch paths, per camera, as asyncio tasks
8. `modules/anpr.py` and `modules/multi_human.py` — once the pipeline above works end-to-end for fence detection

Get fence detection working end-to-end through the full pipeline (RTSP → detect → fence module → live WS + durable POST) before building out ANPR and multi-human, so the two-contract plumbing is proven with one module before adding more.

## Explicitly out of scope for Vision Service

- Persisting anything to a database — that's the backend's job.
- Serving operator actions (ack/escalate/dismiss/zone edit/config change) — Frontend talks to Backend directly for these.
- Being the frontend's authoritative source for confirmed alerts/history — the frontend should treat the backend's rebroadcast as the source of truth for anything durable, even if it also received the same event live from Vision Service first.

## Existing backend schema note

The backend's current schema (`event`, `incident`, `action`, `plate_detection`, hash-chained audit log) already has the right concepts for the durable side of this. It likely needs its ingress and event lifecycle adjusted to receive `DurableEvent` payloads from Vision Service and to broadcast persisted changes to the frontend — not discarded or rebuilt wholesale.
