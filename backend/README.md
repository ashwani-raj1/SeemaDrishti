# IBVAP edge node

One post, one process. Reads detections, judges them against the zones, turns
what matters into events and incidents, records every human decision, and
serves all of it. No cloud service anywhere in the working path.

```
bun install
bun run dev          # http://localhost:8000
bun test
```

## What is built

Three slices of the brief, from L2 up:

| | |
|---|---|
| **Virtual fence** (#03, #13) | Line and polygon zones over normalised frame coordinates. Direction-aware — inbound and outbound are different events. Wait-and-confirm before a critical alarm, measured in seconds so the same setting means the same thing on a slower machine. Classes route three ways: alert, log-only, or ignore. |
| **Event logging** (#04, #19) | Append-only `event` table with a monotonic `seq`. Related events group into incidents so the operator gets pieces of work, not a firehose. Live push over SSE. |
| **Audit** (#33, #34) | Every decision, zone edit and history search is one row in `action`, with who / when / why. Hash-chained and append-only. An incident has no status column — its state is derived from the log. |

## Layers

```
L4  hooks     ingress + SSE       src/l4/
L3  meaning   events, incidents, audit   src/l3/
L2  judgement the fence           src/l2/
    storage   sqlite              src/db/
```

Information only moves upward and no layer skips another, which is why a sensor
alert can enter at L3 without the camera pipeline knowing it exists.

## The seam

Detections only enter through one door:

```
POST /hooks/ingress/detections
{
  "camera_id": "cam_fence_north",
  "occurred_at": "2026-08-31T02:14:00Z",
  "simulated": false,
  "detections": [
    { "track_ref": "t-1", "class": "person", "confidence": 0.86,
      "bbox": [0.48, 0.74, 0.045, 0.16] }
  ]
}
```

`bbox` is `[x, y, w, h]` normalised 0..1. The subject's ground point is the
bottom centre of the box.

The built-in simulator (`src/sim/`) posts through the same function a real
detector will, so nothing above it changes when the detector arrives. Everything
it produces is flagged `simulated` in the event itself.

## Routes

```
GET    /api/health
GET    /api/stream                      live events, incidents, decisions (SSE)
GET    /api/config                      org, site, cameras, zones

GET    /api/zones?camera_id=
POST   /api/zones                       supervisor+
PATCH  /api/zones/:id                   supervisor+   audited, before/after
DELETE /api/zones/:id                   supervisor+   audited, reason required

GET    /api/incidents
GET    /api/incidents/:id               incident + events + decision trail
POST   /api/incidents/:id/decision      acknowledge | escalate | dismiss

GET    /api/events                      the searchable log; after_seq= for replay
GET    /api/history                     supervisor+; the search is itself audited
GET    /api/audit
GET    /api/audit/verify                recompute the hash chain

POST   /hooks/ingress/detections
POST   /hooks/ingress/sensor            enters at L3, skips the camera pipeline
```

The acting user is named by the `x-ibvap-actor` header. Real logins are a later
job; what matters here is that no write path is anonymous.

## Not built yet

- No detector. Detections arrive over the hook or from the simulator.
- No video. Evidence is geometry, not frames; the console says so on screen.
- No post-to-HQ sync, no retention sweeper, no cross-camera matching.
