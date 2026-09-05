# SeemaDrishti — IBVAP

Border video analytics that runs **at the post, not in a cloud**.

Three processes: an **edge node** (`backend/`) that judges detections against zones, turns
what matters into incidents and records every human decision, an **operator console**
(`frontend/`), and an **L1 vision pipeline** (`ibvap/`) — CPU-only YOLO11n + ByteTrack
person tracking with cascaded YuNet face detection — that posts real detections into the
same ingress hook the simulator uses. One local SQLite file holds everything — a post with
a dead uplink runs the complete feature set.

- [`docs/CODE_GUIDELINES.md`](docs/CODE_GUIDELINES.md) — architecture and code rules
- [`docs/UI_GUIDELINES.md`](docs/UI_GUIDELINES.md) — console design rules
- [`backend/README.md`](backend/README.md) — what the node serves, route by route

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
zones, three users. It's gitignored; a post never ships its data.

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
`opencv-python` and `ultralytics` (`pip install opencv-python ultralytics`); `yolo11n.pt`
auto-downloads on first run.

```bash
cd ibvap
python run.py --source data/test1.mp4 --show --post-url http://localhost:8000
```

`--post-url` is off by default (the demo runs fully standalone otherwise) — set it to feed
real person-tracking detections into the node instead of the simulator, through the exact
same `/hooks/ingress/detections` seam, unset `simulated` this time. `--camera-id` must
match one already seeded in `backend/src/db/seed.ts` (default `cam_fence_north`). See
`ibvap/claude.md` for the full CPU-budget tuning knobs and known limitations (no
re-identification across long occlusion, face detection needs a close/choke-point range).

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
  run.py            demo/production CLI: source, tuning flags, --post-url
  core/ingest.py    RTSP/file/webcam ingest, source-aware frame policy
  core/person.py    YOLO11n + ByteTrack, movement trails
  core/face.py      cascaded YuNet, scoped to each tracked person's head region
  core/ingress_client.py   DetectionFrame shape + POST, backgrounded so a
                            down node can never stall the detection loop
```

## Troubleshooting

| Symptom | Cause |
|---|---|
| "Cannot reach the edge node" | node not running, or `apiBase` points elsewhere |
| `EADDRINUSE` | `PORT=8100 bun run dev` |
| Live dot red | stream died, reload. It going red **is** the feature |
| Map blank grey | no tile imagery. Expected offline; geometry still draws |
| Want a clean slate | stop the node, `rm backend/ibvap.db*`, restart — it reseeds |
