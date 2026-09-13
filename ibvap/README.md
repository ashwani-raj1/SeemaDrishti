# ibvap — the vision service

Turns video into observations. One process, many cameras, one detection pass per
frame, several pluggable modules reading it.

**The vision service owns realtime observation. The edge node owns durable truth
and operator decisions.** That sentence settles every argument about where a
piece of logic belongs.

```
RTSP ─> capture ─> ONE YOLO11n + ByteTrack pass ─> fence ───────┐
        latest-    per camera, shared by          anpr          ├─> LiveObservation
        frame-wins every module                   multi_human ──┘   WS :8100 → console
                                                                │   ephemeral, droppable
                                                                └─> DurableEvent
                                                                    HTTP :8000 → edge node
                                                                    confirmed, retried
```

This service evaluates fence geometry — a crossing has to be judged against the
frame it happened in, at the rate frames arrive. It does **not** decide what a
crossing means. Severity, and whether a human is woken, follow the zone's
targets, which a supervisor edits on the console and the node stores and audits.
The wire carries a fact; the node applies the policy.

It never writes a database, never learns that an operator acknowledged anything,
and never receives a command.

## Two contracts, not one payload with two destinations

| | Live (WebSocket) | Durable (HTTP) |
|---|---|---|
| Carries | boxes, tracks, unconfirmed guesses | confirmed intrusions, accepted plate reads, camera health |
| Rate | every processed frame | seconds to minutes apart |
| Slow consumer | **dropped** | **queued, retried with backoff, drained on exit** |
| Stored | never | always, by the node |
| Authoritative | no | yes |

If a confirmed intrusion went to the browser *and* the node in parallel, a slow
console or a failed POST would give you alerts visible live but missing from
history, duplicates on reconnect, and operator decisions taken against events
that were never persisted. Two contracts prevent that by construction: **nothing
durable is ever only in a browser.**

## Requirements

Python 3.11, separate from the Bun workspace — `bun run setup` does **not**
install this.

```powershell
python -m pip install -r requirements.txt
```

`yolo11n.pt` downloads itself on first run. Videos and weights live in `data/`,
which is gitignored. CPU-only throughout: there is no CUDA path and none is
assumed — the target is a commodity CPU box, because that is what a BOP has.

**Status: prototype.** Every module says so in its own docstring.

## Run

```powershell
python main.py                           # cameras from IBVAP_WORKER_CAMERAS
python main.py --cameras cam_farm_gate
python main.py --no-backend              # live channel only, nothing recorded
python main.py --seconds 60              # comparable baseline row per laptop
python main.py --imgsz 384 --target-fps 4
```

Full system, three terminals from the repo root:

```powershell
media\bin\mediamtx.exe media\mediamtx.yml   # 1 — media hub  (see media/README.md)
bun run dev                                  # 2 — edge node + console
python ibvap\main.py                         # 3 — vision service
```

Start the node before the vision service when you can: zones come from its
`/api/config`. If it is down, fence modules start with **no zones**, say so on
stdout, and pick them up within `IBVAP_ZONE_REFRESH_SECONDS` of it returning.
No restart needed.

The browser plate scanner is a separate surface on `:8001`, launched from inside
this directory:

```powershell
.\run-anpr.ps1        # installs deps, then uvicorn ai_service:app on :8001
```

## Modules

One shared detection pass per frame; its output goes to every active module. A
module that runs its own detector has misunderstood the design.

| Module | Does | Durable event |
|---|---|---|
| `fence` | polygon intrusion + line crossing, debounce, per-direction cooldown | `intrusion` |
| `anpr` | plate crop → OCR inside a tracked vehicle box | `plate_read` |
| `multi_human` | within-camera person tracking; re-ID is interface-only | `reidentification` |

Which modules run is per camera, in `media/cameras.yml`:

```yaml
defaults:
  modules: [fence, multi_human]            # cheap: arithmetic over the shared pass

cameras:
  - id: cam_farm_gate
    modules: [fence, anpr, multi_human]    # ANPR is opt-in — it loads EasyOCR
  - id: cam_waterline
    modules:                               # mapping form takes params
      fence: { confirm_frames: 4, cooldown_seconds: 30 }
```

Fence **zones** are never written here. They are drawn by an operator, stored by
the node, and pulled from `/api/config` while running — so an edit takes effect
without touching a file or restarting a worker.

**Adding a module:** a new file in `modules/`, a `@register`, and a name in the
manifest. The dispatcher, the WebSocket server and the HTTP sink do not change.
That is the test of whether this layer is actually pluggable.

## Configuration

Three sources, deliberately not merged:

| | Answers | Lifetime |
|---|---|---|
| `media/cameras.yml` | **what** cameras exist, and which modules each runs | committed |
| `.env` | **where** modules run, and what **this** box does | per-machine, gitignored |
| the node's `/api/config` | **zones**, as the operator has them drawn | live |

| Variable | Default | Meaning |
|---|---|---|
| `IBVAP_WORKER_CAMERAS` | `all` | Which cameras *this* machine runs detection on |
| `IBVAP_MEDIA_HOST` / `IBVAP_RTSP_PORT` | `127.0.0.1` / `8554` | Where the media hub is |
| `IBVAP_BACKEND_HOST` / `IBVAP_BACKEND_PORT` | `127.0.0.1` / `8000` | Where the edge node is |
| `IBVAP_BOXES_BIND` / `IBVAP_BOXES_PORT` | `0.0.0.0` / `8100` | Where the console reads observations |
| `IBVAP_WEIGHTS` | `yolo11n.pt` | Detector weights |
| `IBVAP_IMGSZ` | `480` | Inference size |
| `IBVAP_CONF` | `0.35` | Confidence floor |
| `IBVAP_TARGET_FPS` | `6` | Processed frames per second, per camera |
| `IBVAP_ZONE_REFRESH_SECONDS` | `15` | How often zones are re-read from the node |

Every machine reads the same manifest and a different `IBVAP_WORKER_CAMERAS` —
that is what makes one-worker-per-laptop work.

## The durable seam

`POST /hooks/ingress/events`, handled by `backend/src/l4/vision.ts`:

```json
{
  "camera_id": "cam_fence_north",
  "module": "fence",
  "event_type": "intrusion",
  "track_id": 7,
  "timestamp": 91821.44,
  "occurred_at": "2026-09-13T02:14:00.000Z",
  "simulated": false,
  "source_id": "vision.a1b2",
  "data": {
    "track_ref": "a1b2:7", "class": "person", "zone_id": "zone_fence_line",
    "direction": "inbound", "rule": "zone.crossing.confirmed",
    "bbox": [0.44, 0.52, 0.11, 0.27], "crossed_at": [0.50, 0.79],
    "held_seconds": 1.4, "held_frames": 4,
    "confirm_seconds": 3.0, "confirm_frames": 3
  }
}
```

`event_type` is one of `intrusion`, `plate_read`, `camera_health`,
`reidentification`.

- `bbox` on the durable side is `[x, y, w, h]` normalised 0–1; the live side uses
  `[x1, y1, x2, y2]`, also normalised. Normalised is what lets detection run on a
  480p substream while the console displays 720p, and lets a zone survive a
  camera swap. `SharedDetector` produces every form once, in one place.
- The subject's ground point is the **bottom centre** of the box. Using the
  centre would make a subject cross a line half a body-height early.
- `data.track_ref` is `{run_id}:{track_id}`. ByteTrack reuses integer ids and
  restarts from 1 on restart; the node keys `tracked_thing` on
  `(camera_id, track_ref)`, so a bare id lets a new subject inherit a dead one's
  record.
- `timestamp` is producer-monotonic seconds. It cannot step backwards when the
  host clock is corrected, which is what every held-time measurement relies on.
  A malformed value is rejected, not coerced.
- `simulated` is set once, from the manifest's source kind. The console renders a
  **SIMULATED** badge from it.

There is a **second door** on the node and it is not the same door.
`/hooks/ingress/detections` takes raw per-frame detections and judges them with
the node's own `l2/fence.ts` — the simulator posts there. Do not collapse them.

## Design decisions worth defending

- **One detection pass, many modules.** Three modules each running their own
  detector is three times the only cost that matters, for the same boxes three
  times over.
- **YOLO11n (nano).** On CPU there is no headroom for s/m/l. The only size that
  leaves budget for tracking and plate OCR on the same core.
- **One tracker per camera.** ByteTrack state lives on the model object;
  `persist=True` means "this frame continues the previous sequence". Sharing one
  tracker across cameras interleaves unrelated scenes into one association
  problem and produces constant id switches.
- **Capped cadence, not stream rate.** The overlay still reads as live at 5–10
  fps because a person crossing a fence does not move far in 150 ms, while the
  detector does a fraction of the work. Held time is measured in seconds, so
  changing the cadence does not silently change what a confirm window means.
- **Confirm on frames AND seconds.** Frames alone mean four times longer on a
  slower laptop. Seconds alone let a stalled stream "hold" a crossing while
  showing one frozen image.
- **Cascaded plate OCR.** OCR runs only in the lower-centre slice of an
  already-tracked vehicle box, never across the full frame. It excludes
  hallucinations on signage and foliage by construction, not by threshold
  tuning, and binds every read to a track so a watchlist check happens once per
  vehicle rather than once per frame.
- **Source-aware frame policy.** `cv2.VideoCapture.read()` pulls sequentially
  from an internal buffer, so if inference is slower than the camera's rate that
  buffer grows and a "live" feed silently goes stale. A live source therefore
  drops to the newest frame. **A file does the opposite** — it blocks and keeps
  every frame, because a file cannot fall behind and dropping frames there
  discards most of the footage. `core/capture.py` picks per source; do not
  "simplify" it to one behaviour.

## Known limits

Stated plainly rather than discovered in a demo:

- **No re-identification.** `modules/reid.py` ships the interface and a no-op
  provider that answers "I don't know" for every crop. ByteTrack carries no
  appearance model, so a long occlusion produces a *new* track id and a subject
  moving between cameras has no relationship to themselves. Never claim
  persistent re-ID, and never call a tracker id an identity.
- **Plate OCR is resolution-bound.** A plate a few pixels tall cannot be read.
  It works at a gate or checkpoint where plates face the camera, not across a
  wide open scene — which is why `anpr` is opt-in per camera. The working range
  needs measuring in metres on the installed camera.
- **Threads, not processes.** One asyncio task per camera with the CPU work in
  `asyncio.to_thread`. Fine while the GIL is released inside ultralytics/OpenCV
  native code. Not fine for many cameras on one box, where they contend for the
  same cores — the answer there is a process per camera, and the honest first
  answer is one worker per laptop.
- No throughput figure is quoted anywhere because none has been measured on team
  hardware. `main.py` prints the numbers you need at exit, and those are the only
  ones worth repeating.

`claude.md` in this directory carries the full tuning notes and the evidence
rules.
