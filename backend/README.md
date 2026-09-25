# backend — the edge node

One post, one process. It reads detections, judges them against the zones, turns what
matters into incidents, records every human decision, and serves all of it. No cloud
service anywhere in the working path — a post with a dead uplink runs the complete
feature set on one local SQLite file.

```bash
bun install
bun run dev          # http://localhost:8000
bun test
```

First boot creates and seeds `ibvap.db`: BSF, BOP Attari, four cameras, their zones and
targets, two users. It is gitignored — a post never ships its data. Delete the file to
start clean (delete `ibvap.db-wal` too, or SQLite replays it straight back).

## Layers

Information only moves upward and no layer skips another. That constraint is what lets an
anti-drone sensor's alert be dropped into the data model without any part of the camera
pipeline knowing it exists.

```
L4  hooks       ingress, SSE stream           src/l4/
L3  meaning     zones, cameras, events,       src/l3/
                incidents, audit
L2  judgement   the virtual fence             src/l2/
    storage     sqlite, schema, migrations    src/db/
```

`src/http.ts` holds the shared plumbing — who is acting, role gates, error-to-status —
so route modules can be split by subject without importing the server back into themselves.

## The three things this exists to do

**Virtual fence** (`l2/`). Line and polygon zones over normalised 0–1 frame coordinates,
so a shape survives a camera being swapped for a different resolution. Direction-aware:
inbound and outbound are different events. A crossing must persist for `confirmSeconds`
before a critical alarm fires — measured in *seconds*, not frames, because counted in
frames the same setting silently means four times longer on a slower machine.

**Event logging** (`l3/events.ts`). Append-only `event` table, enforced by triggers, with a
monotonic `seq` — the field that makes reconnect-and-replay cheap. Events group into
incidents by zone and time window so an operator's unit of work is "someone crossed the
fence", not forty detections. Live push over SSE.

**Audit** (`l3/audit.ts`). Every decision, zone edit, camera change and history search is
one row with who / when / why. Append-only and hash-chained. **`incident` has no status
column** — its state is a SQL view derived from the decision log, so there is no code path
that changes an incident without leaving an attributed row behind.

## The zone model

A zone is a named place watched by **one or more** cameras. It holds no geometry of its
own, because a polygon drawn in one camera's frame is meaningless in another's.

| Table | Holds |
|---|---|
| `zone` | identity and policy — name, kind, sector |
| `zone_camera` | one camera's shape, direction and confirm delay |
| `zone_target` | what to detect against, ordered |

`zone_target.camera_id IS NULL` is the zone's own policy. A row naming a camera overrides
it for that class on that camera alone — one policy per zone, with exceptions stated
explicitly rather than by duplicating the list.

**Priority is list position**, never a number the caller sends, so two targets can never
claim the same rank. `action: 'log_only'` is the animal case: written to the record, never
raised. That distinction is the whole false-alarm argument — cattle cross the fence
constantly, and an operator woken for them stops trusting the system by the third night.

A camera's `status` is **observed** (the blindness ladder, written by the analysis engine);
`enabled` is **decided** (a person took the feed out of service). They are kept apart
because "we cannot see" and "we stopped looking" need different responses.

### Vehicle classification and ANPR

Vehicle detections use `class: "vehicle"` plus `vehicle_type`: `car`, `truck`,
`two_wheeler`, `bus`, `tractor`, or `other`. A camera model may include a
localised, OCR-read `plate`; it is normalised to uppercase and retained in the
event evidence along with both confidence values. This endpoint accepts model
results—it does not claim to run a detector or OCR engine itself.

## Routes

```
GET    /api/health
GET    /api/stream                          live events, incidents, decisions (SSE)
GET    /api/config                          org, site, cameras, zones

GET    /api/zones
POST   /api/zones                           supervisor+
GET    /api/zones/:id
PATCH  /api/zones/:id                       supervisor+
DELETE /api/zones/:id                       supervisor+   deactivates; events still point at it
PUT    /api/zones/:id/targets               supervisor+   whole list; position is priority
POST   /api/zones/:id/cameras               supervisor+   joins with a placeholder shape
PATCH  /api/zones/:id/cameras/:cameraId     supervisor+   position the shape; marks it placed
DELETE /api/zones/:id/cameras/:cameraId     supervisor+   keeps the camera's overrides
PUT    /api/zones/:id/cameras/:cameraId/targets   supervisor+   empty list clears the override

GET    /api/cameras
GET    /api/cameras/:id
PATCH  /api/cameras/:id                     supervisor+   out-of-service needs a reason
GET    /api/cameras/:id/incidents           this feed's whole record, plus its siblings

GET    /api/incidents                       ?camera_id= ?zone_id= ?status=
GET    /api/incidents/:id                   incident + events + decisions + cross-reference
POST   /api/incidents/:id/decision          acknowledge | escalate | dismiss

GET    /api/events                          the searchable log; after_seq= for replay
GET    /api/history                         supervisor+; the search is itself audited
GET    /api/audit
GET    /api/audit/verify                    recompute the hash chain

POST   /hooks/ingress/detections            the only door a detection enters through
POST   /hooks/ingress/sensor                enters at L3, skipping the camera pipeline
```

The acting user is named by the `x-ibvap-actor` header. Real logins are a later job; what
matters now is that **no write path is anonymous**. Escalate, dismiss and taking a feed out
of service are refused without a stated reason (`422`).

## Ingress

See [`../ibvap/README.md`](../ibvap/README.md) for the detection frame shape. Everything
arrives through `parseDetectionFrame`, whether it came from the real detector, the built-in
simulator (`src/sim/`), or curl. `simulated` is set once by the adapter so it cannot be
forgotten downstream.

The simulator posts through the same function the HTTP hook calls — so the path a real
detector takes is the path that gets exercised every time somebody runs a scenario:

```bash
curl -X POST localhost:8000/api/sim/scenario -H 'content-type: application/json' \
     -d '{"name":"intruder"}'     # or cattle, flicker, farmer_gate, drone_pickup, …
```

## Migrations

`db/migrate.ts` runs in two halves around `schema.sql`, because `CREATE TABLE IF NOT
EXISTS` silently does nothing to a database that is already running. It carries a legacy
single-camera `zone` table across to the three-table shape, and adds columns an existing
file has not seen. Covered by `test/migrate.test.ts` — including re-running on an
already-migrated database, and a zone whose camera was deleted.

## Not built yet

- ANPR plate detections follow `organisation.retention_days` (15 days by default)
  and are swept automatically during detection ingestion and log reads.
- No post-to-HQ sync. The `seq` field and the queue design are there for it; the sync agent
  is not.
- No cross-camera appearance matching.
- No real login. `x-ibvap-actor` stands in.
