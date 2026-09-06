# ibvap — the vision service

Turns video into detections. Nothing else.

This is the L1 half of the system: it pulls RTSP, runs person detection and tracking per
camera, and pushes what it finds down two channels. It does **not** know what a zone is,
what a severity is, or what an incident is — that lives one layer up in the edge node.
Keeping it ignorant is deliberate: the moment force-specific configuration reaches the
pixel pipeline, the "one program, many configuration files" claim is gone.

```
RTSP ──> ingest ──> YOLO11n + ByteTrack ──> YuNet faces ──┬──> box channel  (WS)  → console
         latest-      one tracker per        inside person │     hot, ephemeral
         frame-wins   camera                 boxes only    └──> ingress client (HTTP) → node
                                                                 cold, durable
```

Two channels carrying the same detections, on purpose. The console needs them *now* and
can lose them; the node needs every one and must keep them. Muxing the two would mean a
dropped websocket frame silently losing a record.

## Requirements

Python 3.11, separate from the Bun workspace — `bun run setup` does **not** install this.

```bash
pip install -r requirements.txt      # ultralytics, opencv-python, lap, websockets, PyYAML
```

`yolo11n.pt` downloads itself on first run. Videos and weights live in `data/`, which is
gitignored. CPU-only throughout: there is no CUDA path and none is assumed — the target is
a commodity CPU box, because that is what a BOP actually has.

**Status: prototype.** Every module says so in its own docstring.

## Two ways to run it

**`run.py`** — one video source, for looking at the detector itself.

```bash
python run.py --source data/test1.mp4 --show
python run.py --source data/test1.mp4 --post-url http://localhost:8000
```

**`service.py`** — the real shape: cameras from `media/cameras.yml`, RTSP from the media
hub, both output channels live.

```bash
python service.py                        # cameras from IBVAP_WORKER_CAMERAS
python service.py --cameras cam_farm_gate
python service.py --no-backend           # overlay only, nothing written down
```

## Flags that matter (`run.py`)

| Flag | Default | Why you would change it |
|---|---|---|
| `--source` | *required* | File, RTSP URL, or webcam index |
| `--post-url` | off | Feed the edge node. **Off by default** so the demo runs standalone |
| `--camera-id` | `cam_fence_north` | Must match a camera seeded in `backend/src/db/seed.ts` |
| `--imgsz` | `640` | Drop to `480` to buy frame rate on a slow box |
| `--conf` | `0.35` | Detector confidence floor |
| `--detect-every` | `1` | Run the detector every Nth frame |
| `--face-every` | `5` | Faces are cascaded; they do not need every frame |
| `--no-face` | off | Skip face detection entirely |
| `--show` | off | Open the overlay window |
| `--loop` | off | Replay the file forever, for a demo that has to keep running |

When it is too slow, tune in this order: `--imgsz 480`, then `--detect-every 2`, then
`--face-every 10`. `--imgsz` is the biggest single win and costs accuracy on small distant
people — which is the trade to state out loud rather than discover on stage.

## Configuration

Addresses come from `.env` at the repo root; the camera manifest comes from
`media/cameras.yml`. The two are deliberately not merged — they answer different
questions and have different lifetimes:

| | Answers | Shared? |
|---|---|---|
| `media/cameras.yml` | **what** cameras exist | committed |
| `.env` | **where** modules run, and what **this** box does | per-machine, gitignored |

That split is what makes one-worker-per-laptop work: every machine reads the same
manifest and a different `IBVAP_WORKER_CAMERAS`.

| Variable | Default | Meaning |
|---|---|---|
| `IBVAP_WORKER_CAMERAS` | all | Which cameras *this* machine runs detection on |
| `IBVAP_MEDIA_HOST` / `IBVAP_RTSP_PORT` | `127.0.0.1` / `8554` | Where the media hub is |
| `IBVAP_BACKEND_HOST` / `IBVAP_BACKEND_PORT` | `127.0.0.1` / `8000` | Where the edge node is |
| `IBVAP_BOXES_BIND` / `IBVAP_BOXES_PORT` | `0.0.0.0` / `8100` | Where the console reads boxes |
| `IBVAP_WEIGHTS` | `yolo11n.pt` | Detector weights |
| `IBVAP_IMGSZ` | `480` | Inference size |
| `IBVAP_CONF` | `0.35` | Confidence floor |
| `IBVAP_DETECT_EVERY` | `2` | Run the detector every Nth frame |

`service.py` deliberately runs leaner than `run.py`: `480`/every-2nd-frame against
`640`/every-frame. `run.py` is for looking at the detector on one source; the service has
to share a CPU with the other workers on the box.

## The seam

Detections reach the node through one door, the same one the simulator uses:

```
POST /hooks/ingress/detections
{
  "camera_id": "cam_fence_north",
  "occurred_at": "2026-09-06T02:14:00Z",
  "capture_mono": 1234.567,
  "simulated": false,
  "detections": [
    { "track_ref": "7", "class": "person", "confidence": 0.86,
      "bbox": [0.48, 0.74, 0.045, 0.16] }
  ]
}
```

`bbox` is `[x, y, w, h]` normalised 0–1. The subject's ground point is the bottom centre
of the box — using the centre would make a tall person cross a line half a body early.

`capture_mono` is a monotonic clock in seconds. It is optional, but send it: the fence
measures how long a crossing was held, and wall-clock time can step backwards under NTP.
A malformed value is rejected rather than coerced, because a `NaN` there would silently
poison the confirm window.

`simulated` is set once, by the adapter. The console renders a **SIMULATED** badge from
it, so a synthetic detection can never be mistaken for a real one downstream.

## Design decisions worth defending

- **YOLO11n (nano).** On CPU there is no headroom for s/m/l. This is the only size that
  leaves budget for tracking and faces on the same core.
- **One tracker per camera.** ByteTrack state lives on the model object and `persist=True`
  means "this frame continues the previous sequence". Sharing one tracker across cameras
  interleaves four unrelated scenes into one association problem and produces constant id
  switches. The cost is N models resident — which is the real reason worker count is a
  per-machine setting rather than a constant.
- **Cascaded faces.** The face detector runs inside the upper portion of an already-tracked
  person box, never over the full frame. Full-frame face detection at CPU speed would eat
  the entire budget for a result that is mostly background.
- **Source-aware frame policy.** `cv2.VideoCapture.read()` pulls sequentially from an
  internal buffer, so if inference is slower than the camera's frame rate that buffer grows
  and a "live" feed silently goes stale. A live source therefore drops: the reader drains
  to the newest frame and latency stays bounded. **A file does the opposite** — it blocks
  and keeps every frame, because a file has no real time to fall behind and dropping
  frames there silently discards most of the footage and corrupts any evaluation run
  against it. `core/ingest.py` picks per source; do not "simplify" it to one behaviour.
- **Person-only inference** (`classes=[0]`). Cheaper NMS and no spurious boxes to filter
  downstream.

## Known limits

Stated plainly rather than discovered in a demo:

- **No re-identification.** ByteTrack carries no appearance model, so a long occlusion
  produces a *new* track id. Short occlusions are recovered by its low-confidence
  association pass. Never claim persistent re-ID.
- **Face detection is resolution-bound.** A 60 px-tall person has roughly a 12 px face and
  no detector finds that. Faces work at choke points — a gate, a check post, a doorway —
  not across open terrain. The working range needs measuring in metres on real hardware;
  it has not been.
- **YuNet does not identify anyone.** It returns a box and five landmarks. This is
  detection, and the distinction is not pedantic — identification is a different
  capability with different legal consequences.
- Four workers on one CPU box contend for the same cores and each one's frame rate falls
  roughly in proportion. The design answer is one worker per machine. No throughput figure
  is quoted here because none has been measured on team hardware — `service.py` prints the
  numbers you need at exit, and those are the only ones worth repeating.

`claude.md` in this directory carries the full tuning notes.
