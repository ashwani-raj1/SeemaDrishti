# API reference

Every endpoint in the system, across all four processes.

## The processes and their ports

| Process | Port | Speaks | Source |
|---|---|---|---|
| **Edge node** | `8000` | HTTP + SSE | `backend/` |
| **Vision service** | `8100` | WebSocket | `vision-service/main.py` |
| **Media hub** (MediaMTX) | `8554` RTSP · `8889` WHEP · `9997` control | RTSP / WebRTC / HTTP | `media/` |
| **Local ANPR** | `8001` | HTTP | `vision-service/ai_service.py` |

Addresses come from `.env` at the repo root — `IBVAP_BACKEND_PORT`,
`IBVAP_BOXES_PORT`, `IBVAP_RTSP_PORT`, `IBVAP_WHEP_PORT`. Nothing hardcodes them.

```
media hub ──RTSP──> vision service ──WS :8100──────> console
    │                     │                            │
    └──WHEP :8889─────────┼──HTTP /hooks/ingress──> edge node ──SSE /api/stream──┘
       (video to browser) │                         :8000
                          └── reads zones from /api/config
```

---

## Who is calling: `x-ibvap-actor`

Every request may carry an actor header. It stands in for a login — the caller
names itself and the name is recorded. What matters for this slice is that **no
write path is anonymous.**

```
x-ibvap-actor: usr_supervisor
```

Defaults to `usr_operator` when absent. An unknown id is `403`.

**Roles:** `operator` < `supervisor` < `admin`. Routes marked **S+** below need
supervisor or admin. The console enforces the same boundary earlier, but the
node is the one that decides.

**Reason required.** Three verbs are refused with `422` unless a written reason
is supplied: `incident.escalate`, `incident.dismiss`, `zone.delete`. This is the
database agreeing with the screen, not a politeness.

## Status codes

| Code | Means |
|---|---|
| `200` / `201` | Done |
| `202` | Accepted at an ingress hook |
| `400` | Bad field — the message names it |
| `403` | Wrong role, or unknown actor |
| `404` | No such thing |
| `422` | A reason is required for this verb |
| `500` | Node fault |

CORS is `*` on every route; headers `content-type, x-ibvap-actor`.

---

# Edge node — `http://127.0.0.1:8000`

## System

| Verb | Path | Notes |
|---|---|---|
| GET | `/api/health` | Liveness, live track count, SSE subscriber count, simulator state |
| GET | `/api/config` | **The console's boot call.** Org, site, users, media addresses, every camera with its resolved zones |
| GET | `/api/stream` | SSE. See [Live push](#live-push--apistream) |
| GET | `/api/settings` | Node behaviour in force: `{ groupingWindowSeconds }` |
| PATCH | `/api/settings` | `{ groupingWindowSeconds?, reason? }` — supervisor+, audited |

`/api/config` is also what the **vision service** polls for zones, every
`IBVAP_ZONE_REFRESH_SECONDS`. It returns addresses only — a real camera's RTSP
URL carries credentials and never leaves the hub. It carries the same
`settings` object as `/api/settings`, so the console gets it on the boot call.

`groupingWindowSeconds` is how long an incident stays open to new events
sharing its group key — see [Incidents](#incidents). `0`–`3600`, default
`300`; anything outside that range is a `400`. A `PATCH` that submits the value
already in force changes nothing and writes no audit row.

## Incidents

| Verb | Path | Query / body |
|---|---|---|
| GET | `/api/incidents` | `status`, `camera_id`, `zone_id`, `limit` |
| GET | `/api/incidents/:incidentId` | Returns incident + events + actions + cross-reference |
| POST | `/api/incidents/:incidentId/decision` | `{ decision, reason? }` |

`decision` is `acknowledge` \| `escalate` \| `dismiss`. Escalate and dismiss
need `reason` (`422` without).

**Recording the decision IS the state change** — there is no status column, so
an incident cannot change state without an audit row.

### How events become one incident

An event joins an existing incident when **all three** hold: same `groupKey`,
the incident's `last_event_at` is within `groupingWindowSeconds` of the new
event's `occurredAt`, and the incident is not `DISMISSED`. Otherwise a new
incident opens.

- Group keys are built by the producer: `camera:zone` for fence crossings and
  sensor contacts, `camera:health`, `camera:reid`, and
  `camera:zone:plate:PLATE` for plate reads.
- The window **slides** — it is measured off the last event, not off
  `opened_at`, so continuous activity keeps one incident alive.
- Severity and title are **worst-wins**: a later, more serious event rewrites
  both.
- A dismissed incident is **never** reopened.

## Investigate

| Verb | Path | Query |
|---|---|---|
| GET | `/api/events` | `camera_id`, `zone_id`, `severity`, `class`, `alertable`, `since`, `until`, `after_seq`, `limit` |
| GET | `/api/history` | **S+** — same filters, minus `after_seq` |
| GET | `/api/audit` | `actor_id`, `verb`, `target_type`, `target_id`, `since`, `until`, `limit` |
| GET | `/api/audit/verify` | Recompute the hash chain, report the first break |

**Every history search is itself recorded** as a `history.search` action. "Who
went looking, and for what" is as answerable as "who dismissed this alarm".

`/api/audit/verify` returns `{ ok, checked, brokenAt }`. This is the
tamper-evident log — the honest answer to the "Blockchain & Cybersecurity" theme
tag, without a blockchain.

## Cameras

| Verb | Path | Body / query |
|---|---|---|
| GET | `/api/cameras` | — |
| POST | `/api/cameras` | **S+** `{ id, name?, streamUrl?, reason? }` |
| GET | `/api/cameras/:cameraId` | — |
| PATCH | `/api/cameras/:cameraId` | **S+** `{ name?, streamUrl?, enabled? }` |
| GET | `/api/cameras/:cameraId/incidents` | `status`, `limit` |
| GET | `/api/media/cameras` | What the hub is serving, joined with what the node knows |

**`POST /api/cameras` — `id` must be the hub's path name, verbatim.** The vision
service stamps that exact string on every detection and the node matches on it.
Idempotent: re-adding an existing camera returns `200`, not an error.

Do **not** add cameras by editing `db/seed.ts` — `seed()` returns early once the
organisation row exists, so on a used database it does nothing. See
[`ADDING_A_CAMERA.md`](ADDING_A_CAMERA.md).

**`GET /api/media/cameras`** proxies MediaMTX because its control API sends no
CORS header *and* exposes camera credentials. Returns:

```json
{
  "hub": { "url": "http://127.0.0.1:9997", "reachable": true, "error": null },
  "cameras": [{
    "id": "cam_garden", "name": "BOP-05 Garden",
    "ready": true, "readySince": "...", "readers": 1,
    "width": 854, "height": 480, "codec": "H264",
    "whepUrl": "http://127.0.0.1:8889/cam_garden/whep",
    "seeded": true, "status": "FULL", "enabled": true
  }]
}
```

`seeded: false` is the one failure that looks healthy: the hub serves video, the
node rejects every detection, and no incident can ever open.

## Zones

| Verb | Path | Body |
|---|---|---|
| GET | `/api/zones` | — |
| GET | `/api/zones/areas` | — the area labels in use, derived from live zones |
| POST | `/api/zones` | **S+** `{ name, kind, area?, cameras[] \| cameraIds[], targets[], reason? }` |
| GET | `/api/zones/:zoneId` | — |
| PUT | `/api/zones/:zoneId` | **S+** `{ name, kind, area?, cameras[], targets[], reason? }` — replaces the whole zone |
| PATCH | `/api/zones/:zoneId` | **S+** `{ name?, kind?, area?, active?, reason? }` |
| DELETE | `/api/zones/:zoneId` | **S+** `{ reason }` — **required** |
| PUT | `/api/zones/:zoneId/targets` | **S+** `{ targets[], reason? }` — replaces the list |
| POST | `/api/zones/:zoneId/cameras` | **S+** `{ cameraId, reason? }` |
| PATCH | `/api/zones/:zoneId/cameras/:cameraId` | **S+** `{ geometry?, points?, direction?, confirmSeconds?, reason? }` |
| DELETE | `/api/zones/:zoneId/cameras/:cameraId` | **S+** `{ reason }` |
| PUT | `/api/zones/:zoneId/cameras/:cameraId/targets` | **S+** camera-specific overrides; empty list restores zone policy |

**A zone owns policy; each camera owns its own shape.** A polygon drawn in one
camera's frame is meaningless in another's, so geometry lives on the binding.

`points` are **normalised 0–1 in the camera's frame** — the exact coordinates
`vision-service/modules/fence.py` judges against. `PATCH …/cameras/:cameraId` with
`points` is what the console's shape editor calls.

**`geometry` is not cosmetic, and the two values do not behave alike.** A
`polygon` is judged by `point_in_polygon` — inbound is entering it, outbound is
leaving, and the shape that fires is the shape that was drawn. A `line` is
judged by two different rules at once: `side_for_zone` takes the **infinite**
line through the first and last vertex, while a crossing additionally requires
the subject's movement to intersect a **drawn segment**. So a kinked line
reports side changes all over the frame while only ever firing where it was
actually drawn, and the vertices between the ends affect nothing but where a
crossing may occur. Draw a region as a polygon.

**`cameras[]` carries each camera's shape**, so a zone and the geometry it is
judged by are written in one transaction: `{ cameraId, geometry?, points?,
direction?, confirmSeconds?, targets? }`. Omit `points` and the camera joins on
the placeholder with `placed: false` — on `PUT` it instead keeps the shape it
already had, so renaming a zone never un-draws it. `cameraIds[]` remains
accepted on `POST` for "add these cameras, undrawn". On `PUT`, a camera's
`targets: []` **clears** its overrides and restores the zone policy, while
omitting the key on `POST` leaves it with none.

**An area is a free-text label**, not a shape and not an id. `GET
/api/zones/areas` returns the `DISTINCT` labels the live zones carry, so an area
exists exactly as long as a zone uses it and there is no second list to keep in
step. It was `sector` until it collided with `camera.sector` (the post a camera
belongs to); the migration in `db/migrate.ts` carries old values across.

Target order **is** priority — position in the array decides which target wins.
`action: "log_only"` is the animal filter: written down, never alerted.

**`confirmSeconds` is only half the rule.** `modules/fence.py` also enforces
`confirm_frames`, and a crossing must satisfy both. At a typical 6 fps worker,
`2.0` means roughly twelve processed frames on the far side — longer than a
vehicle's track usually survives, so a plausible-looking value can mean nothing
ever confirms. The console shows the frame count beside the field for this
reason.

## Watchlist and plate reads

| Verb | Path | Body / query |
|---|---|---|
| GET | `/api/watchlist` | `search`, `active`, `limit`, `offset` |
| POST | `/api/watchlist` | **S+** create an entry |
| GET | `/api/watchlist/stats` | Counts by status |
| GET | `/api/watchlist/detections` | `camera_id`, `plate`, `match_status`, `limit`, `offset` |
| POST | `/api/watchlist/detect` | Record a vehicle + plate observation |
| POST | `/api/watchlist/simulate` | `{ preset? }` — demo detection |
| POST | `/api/watchlist/analyze-frame` | Frame analysis helper |
| GET | `/api/watchlist/:id` | — |
| PATCH | `/api/watchlist/:id` | **S+** |
| DELETE | `/api/watchlist/:id` | **S+** `{ reason }` |

Plates are normalised (`PB02AK4821`) and stored formatted (`PB 02 AK 4821`).

## Ingress hooks

**Two doors, and they are not the same door.**

| Verb | Path | Who posts | What it does |
|---|---|---|---|
| POST | `/hooks/ingress/detections` | the **simulator** | Raw per-frame detections, judged here by `l2/fence.ts` |
| POST | `/hooks/ingress/events` | the **vision service** | Already-confirmed events |
| POST | `/hooks/ingress/sensor` | external sensors | Enters at L3, skipping the camera pipeline |

No auth on the ingress hooks. Both detection doors return `202`.

### `POST /hooks/ingress/events`

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

`event_type` ∈ `intrusion` · `plate_read` · `camera_health` · `reidentification`.
Handler: `backend/src/l4/vision.ts`.

- **`bbox` is `[x, y, w, h]` normalised 0–1** on this contract. The subject's
  ground point is the **bottom centre** — the box centre would cross a line half
  a body-height early.
- **`track_ref` is `{run_id}:{track_id}`.** ByteTrack restarts ids from 1 on
  process restart, and the node keys `tracked_thing` on
  `(camera_id, track_ref)`; a bare id lets a new subject inherit a dead one's
  record.
- **`timestamp` is producer-monotonic seconds**, not wall clock. Malformed
  values are rejected, not coerced — a `NaN` in a clock poisons every duration
  computed from it.
- **`camera_id` must already be registered** or the event is rejected (`400`).

**The service sends a fact; the node applies the policy.** Severity and whether
a human is woken follow the zone's operator-editable targets — the vision
service never chooses them.

### `POST /hooks/ingress/detections`

```json
{ "camera_id": "cam_fence_north", "occurred_at": "...", "capture_mono": 1234.567,
  "simulated": false, "source_id": "sim",
  "detections": [{ "track_ref": "a1b2:7", "class": "person", "confidence": 0.86,
                   "bbox": [0.48, 0.74, 0.12, 0.16] }] }
```

Same `bbox` convention. `capture_mono` is optional but wanted — the fence
measures held time by differencing it.

## Simulator

| Verb | Path | Body |
|---|---|---|
| GET | `/api/sim` | status + scenario names |
| POST | `/api/sim/start` | `{ ambient? }` |
| POST | `/api/sim/stop` | — |
| POST | `/api/sim/scenario` | `{ name }` |

Scenarios: `intruder`, `cattle`, `flicker`, `farmer_gate`, `patrol_road`,
`boat_waterline`, `drone_pickup`. Everything it produces is flagged
`simulated: true` and badged on screen.

---

# Live push — `GET /api/stream`

Server-sent events on the node's own port. No Redis, no queue service — a second
thing to power and repair at a post that may not have mains electricity.

```
event: hello
data: {"at":"2026-09-13T09:26:38.868Z"}
```

| `event:` | Carries |
|---|---|
| `hello` | On connect |
| `heartbeat` | Keep-alive |
| `event` | A recorded event |
| `incident` | An incident opened or changed |
| `action` | An operator decision |
| `camera` | Camera or zone configuration changed |
| `plate_detection` | A plate read was stored |
| `watchlist_change` | A watchlist entry changed |

> **Known inconsistency:** `StreamMessage` in `backend/src/l4/bus.ts` declares
> only the first six. `plate_detection` and `watchlist_change` are published at
> runtime and consumed by the console, but are absent from the type — which is
> the source of the standing `tsc` errors in `l3/watchlist.ts`. The frames work;
> the type needs widening.

**This channel is authoritative.** The console must treat the node's rebroadcast
— not a message from the vision service — as the truth for anything durable.

---

# Vision service — `ws://127.0.0.1:8100`

One socket for the whole console, multiplexed by camera **and** module. Browsers
cap connections per host, so four tiles must not mean four sockets.

**Nothing here is a record.** Observations are ephemeral: never stored, never
replayed, safe to drop. If this channel dies, the video keeps playing and the
record keeps recording.

## Server → client

**`hello`** — on connect.

**`live`** — one message *per module per frame*, sent **even when `tracks` is
empty**. An empty list is how the overlay learns a subject left; silence is how
a console tells a dead detector from a quiet border.

```json
{ "kind": "live", "camera_id": "cam_garden", "module": "fence",
  "frame_ts": 91821.44,
  "tracks": [{ "track_id": 7, "bbox": [0.44, 0.52, 0.55, 0.79],
               "confidence": 0.86, "class": "person",
               "extra": { "track_ref": "a1b2:7", "trail": [[0.5, 0.4]],
                          "zones": [{ "zone_id": "zn_3", "name": "Fence north",
                                      "side": -1, "pending": true, "held": 1.2,
                                      "direction": "inbound" }] } }] }
```

**`bbox` here is `[x1, y1, x2, y2]` normalised** — *different from the durable
contract's `[x, y, w, h]`*. Both are produced once, in `SharedDetector`.

`extra` is the module's transient slot, and it differs per module:

| Module | `extra` carries |
|---|---|
| `fence` | `track_ref`, `ground`, `trail`, `zones[]` with `side` / `pending` / `held` |
| `anpr` | `track_ref`, `vehicle_type`, `plate { text, confidence, bbox, confirmed: false }` |
| `multi_human` | `track_ref`, `ground`, `trail`, `age_seconds`, `matched_ref` |

Nothing in `extra` is confirmed. A live plate guess is not a plate read — the
accepted one arrives from the node as a `plate_detection`.

**`status`** — heartbeat every 2 s, on its own queue so a 6/s box stream cannot
starve it.

```json
{ "kind": "status", "run_id": "68ca", "uptime_s": 30.8,
  "cameras": [{ "camera_id": "cam_garden", "modules": ["fence","anpr"],
                "simulated": true, "feed": "live", "frames": 132, "fps": 4.33,
                "detector_ms": 203.3, "detector_calls": 109,
                "drop_rate": 0.77, "reconnects": 0 }],
  "durable": { "sent": 10, "failed": 0, "shed": 0, "queued": 0 } }
```

These are the same numbers the run summary prints at exit — one set of figures,
so the console and the measurements cannot disagree.

## Client → server

```json
{ "t": "subscribe",   "cameras": ["cam_garden"] }
{ "t": "unsubscribe", "cameras": ["cam_waterline"] }
```

Narrows which cameras this client receives. `status` ignores the filter — the
detector being alive is a fact about the process, not about a camera.

---

# Local ANPR — `http://127.0.0.1:8001`

Request/response plate reading for the console's scanner, on a frame the browser
hands over. Separate from the vision service: no track to follow, no zone, and
nothing durable produced. CORS allows `localhost:3000` only.

| Verb | Path | Body |
|---|---|---|
| GET | `/health` | — |
| POST | `/detect` | `{ "image": "<data URL or base64 JPEG>" }` |

```json
{ "detections": [{
    "track_id": 3, "track_key": "v1", "vehicle_type": "car",
    "confidence": 0.86, "bbox": [0.12, 0.30, 0.48, 0.77],
    "plate": { "text": "PB02AK4821", "confidence": 0.91,
               "bbox": [0.30, 0.62, 0.41, 0.68] } }] }
```

`bbox` is `[x1, y1, x2, y2]` normalised. `track_key` is a **geometric heuristic**
(IoU + centre distance) scoped to one scanner session so the UI counts a vehicle
once — it is not re-identification and must never be described as one.

Launch from inside `vision-service/`; it imports `core.*` and `modules.*` as siblings.

---

# Media hub — MediaMTX

| Surface | Address | Used by |
|---|---|---|
| RTSP | `rtsp://127.0.0.1:8554/<camera_id>` | vision service, `ffplay`, VLC |
| WHEP | `http://127.0.0.1:8889/<camera_id>/whep` | the browser — **browsers cannot play RTSP** |
| Control | `http://127.0.0.1:9997/v3/paths/list` | the node's `/api/media/cameras` |

The path name **is** the camera id. Whether it is fed by a looping clip or a
camera on a wall is invisible from above — that is what makes swapping one for
the other a config change rather than a code change.

**Do not call `:9997` from the browser.** It sends no CORS header and exposes
source configuration including `user:pass@` RTSP URLs. Go through
`/api/media/cameras`.

`mediamtx.yml` is generated by `python media/configure.py` from
`media/cameras.yml` — do not edit it by hand.

---

## Quick reference

```bash
# is everything up
curl localhost:8000/api/health
curl localhost:9997/v3/paths/list
curl localhost:8001/health

# what the console sees
curl localhost:8000/api/config
curl localhost:8000/api/media/cameras

# act on an incident (escalate needs a reason)
curl -X POST localhost:8000/api/incidents/inc_xyz/decision \
  -H 'content-type: application/json' -H 'x-ibvap-actor: usr_supervisor' \
  -d '{"decision":"escalate","reason":"patrol dispatched"}'

# register a camera the hub already serves
curl -X POST localhost:8000/api/cameras \
  -H 'content-type: application/json' -H 'x-ibvap-actor: usr_supervisor' \
  -d '{"id":"cam_garden","name":"BOP-05 Garden","reason":"new camera"}'

# is the log intact
curl localhost:8000/api/audit/verify

# watch the live channel
python - <<'EOF'
import asyncio, json
from websockets.asyncio.client import connect
async def main():
    async with connect("ws://127.0.0.1:8100") as ws:
        for _ in range(20):
            print(json.loads(await ws.recv()).get("kind"))
asyncio.run(main())
EOF
```
