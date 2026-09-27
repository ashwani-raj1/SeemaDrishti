# SeemaDrishti — IBVAP

Chat Interface

<img width="1912" height="912" alt="image" src="https://github.com/user-attachments/assets/9b32d33b-d68a-4050-938f-58f2799e747f" />
<img width="1912" height="917" alt="image" src="https://github.com/user-attachments/assets/f6aca92d-f510-4bcd-a613-05a06bf43655" />


Border video analytics that runs **at the post, not in a cloud**.

Three processes: an **edge node** (`backend/`) that judges detections against zones, turns
what matters into incidents and records every human decision, an **operator console**
(`frontend/`), and an **L1 vision pipeline** (`ibvap/`) — CPU-only YOLO11n + ByteTrack
person tracking with cascaded YuNet face detection — that posts real detections into the
same ingress hook the simulator uses. One local SQLite file holds everything — a post with
a dead uplink runs the complete feature set.

- [`docs/CODE_GUIDELINES.md`](docs/CODE_GUIDELINES.md) — architecture and code rules
- [`docs/UI_GUIDELINES.md`](docs/UI_GUIDELINES.md) — console design rules
- [`docs/API.md`](docs/API.md) — every endpoint, across all four processes
- [`docs/ADDING_A_CAMERA.md`](docs/ADDING_A_CAMERA.md) — the full camera flow, hub to zone
- [`backend/README.md`](backend/README.md) — what the node serves, route by route
- [`media/README.md`](media/README.md) — the video hub, clips, and where footage comes from
- [`plans/IBVAP_live_feed_path.html`](plans/IBVAP_live_feed_path.html) — why the live path is shaped this way

## Live video

Four modules, and each can run on a different machine — every address comes
from one `.env`, so moving one is editing a line, not editing code.

```
source ──RTSP──> MediaMTX ──┬──RTSP──> vision service ──HTTP──> edge node ──SSE──┐
  clip loop      media hub   │           (detection)             (the record)     │
  or camera                  │                │                                   ▼
                             └──WHEP──────────┴──────WS (boxes)───────────────> console
                                video, hub straight to the browser
```

Three channels to the console, deliberately unmuxed: **video** (WHEP, from the
hub), **boxes** (WS, from the vision service, ephemeral), **the record** (SSE,
from the edge node, durable). None can take the others down — the detector
restarting freezes the boxes and leaves the picture live.

```powershell
Copy-Item .env.example .env
python media/fetch.py --synthetic      # or point cameras.yml at real footage
python media/configure.py
media/bin/mediamtx.exe media/mediamtx.yml   # terminal 1
bun run dev                                  # terminal 2 — node + console
python ibvap/people_service.py               # terminal 3 — human detection + tracking + faces
# python ibvap/service.py                    # or: vehicle detection + ANPR instead
```

`ibvap/` splits into two independent pipelines that do not share a filename (see
[`ibvap/README.md`](ibvap/README.md#two-domains-four-files-on-purpose)) — `people_*.py` for
people (this project's scope items #1–#2), `run.py`/`service.py` for vehicles/ANPR. Only run
one at a time unless you've given each a distinct `--boxes-port`.

Adding a camera is one block in [`media/cameras.yml`](media/cameras.yml).
Which cameras *this* machine runs detection on is `IBVAP_WORKER_CAMERAS` in
`.env` — one worker per laptop is how four cameras fit on team hardware.

## Setup

The node and console need [Bun](https://bun.com) 1.3+ and nothing else — it's the
runtime, bundler, test runner and package manager, and SQLite is built in. The vision
pipeline (`ibvap/`) is a separate Python process; see below.

```bash
curl -fsSL https://bun.com/install | bash   # if you don't have it
exec $SHELL

git clone https://github.com/ashwani-raj1/SeemaDrishti.git
cd SeemaDrishti
bun run setup       # bun install in backend/ and frontend/
bun run dev         # both processes; Ctrl+C stops both
```

Console on **http://localhost:3000**, edge node on **http://localhost:8000**. To run them
separately (cleaner logs): `cd backend && bun run dev`, `cd frontend && bun run dev`.

## First run

The node creates and seeds `backend/ibvap.db` — BSF, BOP Attari, four cameras, their
zones, two users. It's gitignored; a post never ships its data.

The queue starts empty because nothing has happened. Open **Simulator** in the sidebar
and start it — it posts through the same hook a real detector would, and everything it
produces is flagged `SIMULATED` on screen.

Then work the queue: `↑↓` move, `⏎` open, `A` ack, `E` escalate, `D` dismiss. Escalate
and dismiss need a written reason; the node rejects them without one.

```bash
bun test                        # both packages
curl localhost:8000/api/health
```

## Running the real detector

`ibvap/` is a separate Python 3.11 process — not part of `bun run setup`/`dev`. Needs
`pip install -r ibvap/requirements.txt`; `yolo11n.pt` auto-downloads on first run.

```bash
cd ibvap
python people_run.py --source data/test1.mp4 --show --post-url http://localhost:8000
```

`--post-url` is off by default (the demo runs fully standalone otherwise) — set it to feed
real person-tracking detections into the node instead of the simulator, through the exact
same `/hooks/ingress/detections` seam, unset `simulated` this time. `--camera-id` must
match one already seeded in `backend/src/db/seed.ts` (default `cam_fence_north`). See
`ibvap/claude.md` for the full CPU-budget tuning knobs and known limitations (no
re-identification across long occlusion, face detection needs a close/choke-point range).

`run.py` (no `people_` prefix) is the equivalent tool for the separate vehicle/ANPR
pipeline — see [`ibvap/README.md`](ibvap/README.md) for why the two never share a file.

## Configuration

Everything deployment-specific is a value, never a code path: `frontend/client.json`
(brand, `apiBase`, which sections run, basemap), `backend/src/db/seed.ts` (org, site,
cameras, zones), `frontend/src/client/geography.ts` (where the site is).

Two example deployments ship with the repo:

```bash
cd frontend
IBVAP_CLIENT_CONFIG=./client.navy.example.json bun run dev    # coastal, no imagery
```

| Variable | Default | Used by |
|---|---|---|
| `PORT` | `8000` / `3000` | node / console |
| `IBVAP_DB` | `backend/ibvap.db` | node |
| `IBVAP_CLIENT_CONFIG` | `frontend/client.json` | console |
| `NODE_ENV=production` | unset | disables HMR |

## Layout

```
backend/    index.ts → src/server.ts
  src/l4/   the doorway: ingress hooks, SSE bus
  src/l3/   meaning: events, incidents, audit
  src/l2/   judgement: the virtual fence
  src/db/   sqlite, schema.sql, seed
frontend/
  src/features/     one folder per section; registry.tsx declares them all
  src/components/   ui/ = shadcn, ibvap/ = ours
  src/client/       per-deployment config, geography, profiles
  src/lib/          api client, SSE stream, types, formatting
ibvap/      L1 -- Python, separate process, posts through the same ingress hook
  people_run.py     people: single-source debug CLI, --post-url, --show
  people_service.py people: real multi-camera shape, cameras.yml + .env
  run.py            vehicles/ANPR: single-source debug CLI (same shape as above)
  service.py        vehicles/ANPR: real multi-camera shape
  ai_service.py     vehicles/ANPR: local FastAPI plate-OCR helper, browser-driven
  core/ingest.py    RTSP/file/webcam ingest, source-aware frame policy (shared)
  core/person.py    YOLO11n + ByteTrack, movement trails (people)
  core/face.py      cascaded YuNet, scoped to each tracked person's head region (people)
  core/vehicle.py   YOLO11n + ByteTrack, vehicle classes (vehicles)
  core/plate.py     cascaded plate OCR, scoped to each tracked vehicle's box (vehicles)
  core/box_channel.py      WS detections -> console overlay, ephemeral (shared)
  core/ingress_client.py   DetectionFrame shape + POST, backgrounded so a
                            down node can never stall the detection loop (shared)
```

## Troubleshooting

| Symptom | Cause |
|---|---|
| "Cannot reach the edge node" | node not running, or `apiBase` points elsewhere |
| `EADDRINUSE` | `PORT=8100 bun run dev` |
| Live dot red | stream died, reload. It going red **is** the feature |
| Map blank grey | no tile imagery. Expected offline; geometry still draws |
| Want a clean slate | stop the node, `rm backend/ibvap.db*`, restart — it reseeds |
