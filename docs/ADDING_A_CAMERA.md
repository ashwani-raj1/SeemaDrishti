# Adding a camera

Three systems have to agree about a camera before it does anything: the **media
hub** serves the video, the **edge node** accepts its detections, and the
**vision service** runs modules on it. Miss one and the failure is quiet — the
tile looks fine and nothing is ever recorded.

The `id` is the same string in all three. It is the hub path, the RTSP URL, and
the `camera_id` on every detection. If it does not match exactly, the node
rejects the frames.

---

## 1. Get the footage into the right shape

Skip if you are pointing at a real RTSP camera.

```powershell
# you have a file already
copy gate.mp4 media\clips\
python media\fetch.py --camera cam_farm_gate --normalise media\clips\gate.mp4

# or let it download and normalise in one step
python media\fetch.py --camera cam_farm_gate --url "https://..."

# or just fix every clip already in media/clips/
python media\fetch.py --normalise
```

**Why `--normalise` is not optional.** The hub publishes with `-c:v copy`, which
only works if the file is already the right shape. A file that is not will
publish to RTSP, play fine in VLC, negotiate in the browser — **and then show a
black tile**. Four things have to be true, and `--normalise` enforces all four:

- **H.264** — VP9 or AV1 forces the hub to transcode on every restart, burning
  the CPU the detector needs.
- **No B-frames** (`-bf 0`, baseline profile) — WebRTC cannot carry them. This is
  the usual cause of "works in VLC, black in Chrome".
- **`yuv420p`** — the only chroma format every browser decodes.
- **Keyframe every ~2s** (`-g 50`) — WebRTC cannot start until it sees one, so
  sparse keyframes make a tile take many seconds to appear.

Re-running is free: files that already conform are skipped.

---

## 2. Declare it in the manifest

One block in `media/cameras.yml`:

```yaml
  - id: cam_garden
    label: BOP-05 Garden
    detect: true
    modules: [fence, anpr, multi_human]   # omit to take defaults.modules
    source:
      kind: file                          # file | rtsp | webcam
      path: clips/virtual_fence.mp4
```

- `detect: false` still publishes video — a live tile with no boxes. That is a
  legitimate state, not a failure.
- `modules:` picks which detectors run. ANPR is opt-in per camera because plate
  reading only works where plates face the camera at a gate or checkpoint.
- **Zones are never written here.** They are drawn in the console and stored by
  the node — see step 5.

Then regenerate the hub config and restart it:

```powershell
python media\configure.py
media\bin\mediamtx.exe media\mediamtx.yml
```

Check it is serving:

```powershell
curl http://127.0.0.1:9997/v3/paths/list     # your id, ready=true

ffplay rtsp://127.0.0.1:8554/cam_garden      # what a worker sees
```

---

## 3. Register it with the edge node

Open **Cameras** in the console. Any path the hub serves that the node does not
know shows a red banner with **"Add to the node"**. Click it.

Supervisor or admin only, and recorded in the audit trail as `camera.create`.

By curl, if you prefer:

```bash
curl -X POST http://127.0.0.1:8000/api/cameras \
  -H "content-type: application/json" -H "x-ibvap-actor: usr_supervisor" \
  -d '{"id":"cam_garden","name":"BOP-05 Garden","reason":"new camera on the hub"}'
```

**Do not edit `backend/src/db/seed.ts` for this.** `seed()` returns early once
the organisation row exists, so on any database that has been used it does
nothing. The only way to apply a seed edit is deleting `ibvap.db` — which
destroys every incident, event and audit row. The seed is for a fresh install;
this endpoint is for adding a camera to a running post.

**Symptom if you skip this step:** video plays, detections are rejected, no
incident ever opens. The console flags it, but nothing else will.

---

## 4. Restart the vision service

```powershell
python ibvap\main.py
```

It reads `media/cameras.yml` at startup, so a new camera needs a restart. Zones
do not — those are re-read every `IBVAP_ZONE_REFRESH_SECONDS`.

Confirm in the run summary at exit: the camera should appear with a non-zero
`fps` and its modules listed.

---

## 5. Give it a zone

A camera with no zone is watched but judged against nothing — it can never
produce an intrusion, however much crosses it.

**Zones → pick or create a zone → add the camera → "Draw on camera".** Click
points on the live frame, drag to adjust, pick line or area, save with a reason.

The points are normalised 0–1 **in the camera's frame**, which is the exact
coordinate system the detector compares against — what you draw is what fires.
For a line zone, inbound is the right-hand side looking from the first point to
the last; the editor draws an arrow showing it.

The vision service picks the change up within one refresh interval. No restart.

---

## 6. Survey its position (optional)

Add an entry to `frontend/src/client/geography.ts` beside the others:

```ts
    cam_garden: {
      at: { lat: 31.6045, lon: 74.5819 },
      bearing: 210,   // degrees from true north
      fovDeg: 70,     // horizontal field of view
      rangeM: 380,    // how far it can actually resolve a person
    },
```

`rangeM` is the **measured** useful range, not the lens spec — it feeds the
coverage cones on the map, and an optimistic number draws coverage over ground
nobody can actually see.

Without it the camera works normally but has no grid reference — the service
pages say so plainly rather than inventing one, because a wrong grid reference
sends a patrol to the wrong field.

---

## Checklist

| | Step | Skipping it looks like |
|---|---|---|
| 1 | `fetch.py --normalise` | Plays in VLC, black tile in the console |
| 2 | `cameras.yml` + `configure.py` + restart hub | No such path on the hub |
| 3 | Add to the node (Cameras page) | Video fine, no incident ever opens |
| 4 | Restart the vision service | Video fine, no boxes, no detections |
| 5 | Draw a zone | Boxes fine, no intrusion ever fires |
| 6 | Survey the position | Works, but no grid reference |
