# SeemaDrishti — IBVAP

Border video analytics that runs **at the post, not in a cloud**.

Two processes: an **edge node** (`backend/`) that judges detections against zones, turns
what matters into incidents and records every human decision, and an **operator console**
(`frontend/`). One local SQLite file holds everything — a post with a dead uplink runs
the complete feature set.

- [`docs/CODE_GUIDELINES.md`](docs/CODE_GUIDELINES.md) — architecture and code rules
- [`docs/UI_GUIDELINES.md`](docs/UI_GUIDELINES.md) — console design rules
- [`backend/README.md`](backend/README.md) — what the node serves, route by route

## Setup

Needs [Bun](https://bun.com) 1.3+ and nothing else — it's the runtime, bundler, test
runner and package manager, and SQLite is built in.

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
```

## Troubleshooting

| Symptom | Cause |
|---|---|
| "Cannot reach the edge node" | node not running, or `apiBase` points elsewhere |
| `EADDRINUSE` | `PORT=8100 bun run dev` |
| Live dot red | stream died, reload. It going red **is** the feature |
| Map blank grey | no tile imagery. Expected offline; geometry still draws |
| Want a clean slate | stop the node, `rm backend/ibvap.db*`, restart — it reseeds |
