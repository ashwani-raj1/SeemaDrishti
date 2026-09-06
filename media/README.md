# Media plane

The hub that stands between video sources and everything that reads them.
One process pulls each source once; workers and browsers read from it.

```
source ──RTSP──> MediaMTX ──┬──RTSP──> vision service   (detection)
                             └──WHEP──> browser          (the picture)
```

Nothing else in the system knows whether a path is fed by a looping clip or a
camera on a wall. That is the point: swapping one for the other is a config
change, never a code change.

## Why a hub at all

Cheap IP cameras cap out at two to four concurrent RTSP sessions and degrade
under contention, so having the browser and the detector each pull from the
camera directly does not survive contact with real hardware. One puller, many
readers.

It is also the only way the browser gets video at all — **browsers cannot play
RTSP.** No flag, no polyfill. Something has to repackage the stream, and WHEP
(WebRTC) is the only transport that arrives fast enough for a live security
screen.

## Files

| | |
|---|---|
| `cameras.yml` | **What cameras exist.** Shared, committed. Adding a camera is adding a block here. |
| `configure.py` | `cameras.yml` + `.env` → `mediamtx.yml`. Run after editing either. |
| `fetch.py` | Resolves clip sources: downloads, trims, and re-encodes to H.264. |
| `bin/` | The hub binary. Gitignored — each machine fetches its own. |
| `clips/` | Footage. Gitignored: licences vary per source and git is the wrong place for either problem. |
| `mediamtx.yml` | Generated. Do not edit. |

`.env` at the repo root says **where modules run**; `cameras.yml` says **what
cameras exist**. Keeping them separate is what lets every machine read the same
manifest and a different `IBVAP_WORKER_CAMERAS`.

## Running it

```powershell
# once
Copy-Item .env.example .env

# clips: either drop your own .mp4 into media/clips/ and point cameras.yml at
# it, or give a camera a url and let fetch.py do it
python media\fetch.py --camera cam_fence_north --url "https://..."

# no footage yet and you just want to prove the plumbing:
python media\fetch.py --synthetic

python media\configure.py
media\bin\mediamtx.exe media\mediamtx.yml
```

Then check it:

```powershell
curl http://127.0.0.1:9997/v3/paths/list     # every path, ready=true
ffplay rtsp://127.0.0.1:8554/cam_fence_north # what a worker sees
```

## The synthetic clips are not a detection test

`fetch.py --synthetic` generates a test pattern. It exercises hub → WHEP →
browser and hub → worker decode, and it will produce **zero detections** —
YOLO will not find a person in a test pattern, and it should not. Real footage
is required before any detection claim means anything (claude.md §7).

## Getting footage

claude.md §3 is the authority here, and its first line matters: **no real
Indian border/BOP footage exists publicly and it never will.** Anyone claiming
otherwise is wrong. Legitimate proxies, roughly in order of usefulness:

- **Self-recorded campus gate** — the fastest path to footage matching your
  geometry, no licence to reason about in front of a jury, and the only source
  where you control the occlusion test §12.4 asks for.
- **VIRAT Ground** — fixed high-mounted outdoor cameras, person heights
  10–200 px. The closest geometric match to a BOP camera. Behind a request
  form, so it will not unblock you today.
- **MOT17 / MOT20** — has ground-truth track IDs, so ID-switch rate becomes
  measurable rather than anecdotal (§12.5). Street-level geometry: better as an
  evaluation set than as demo footage.
- **YouTube CCTV-angle clips via yt-dlp** — works immediately. `fetch.py` takes
  whatever URL you give it and ships none: licence terms vary per video, and
  §7 forbids asserting a licence nobody checked.

Do **not** use unauthorised public camera aggregator sites.

## Things that will bite

**B-frames — the one that cost the most time.** WebRTC cannot carry H.264
B-frames. A clip encoded without `-bf 0` publishes fine, plays fine in VLC and
`ffplay`, negotiates fine in the browser, establishes the peer connection —
and then the hub closes the session with *"WebRTC doesn't support H264 streams
with B-frames"* and the tile goes black. `fetch.py` encodes
`-profile:v baseline -bf 0` for exactly this reason. If you hand-encode a clip
or point at a real camera, check it:

```powershell
ffprobe -v error -select_streams v:0 -show_entries stream=profile,has_b_frames -of csv=p=0 clip.mp4
# want: Constrained Baseline,0
```

**H.265 sources.** Most browsers will not accept HEVC over WebRTC, so an H.265
clip or camera forces the hub to transcode every stream — spending exactly the
CPU the detector needs. `fetch.py` re-encodes to H.264 for this reason; real
cameras must be configured to H.264 on the stream the console watches.

**A black tile that never connects.** Almost always ICE: WebRTC hands the
browser a list of IPs gathered from the host's interfaces, and on a Windows
laptop that list usually includes Hyper-V, WSL and VirtualBox adapters. Set
`IBVAP_MEDIA_ADVERTISE_IP` to the hub machine's real LAN IP.

**Missing `-re`.** Without it ffmpeg pushes a file through as fast as it can
decode, and the "camera" runs at several hundred times real time. `configure.py`
always emits it; this is only a hazard if you hand-write a path.

**h264 warnings at the loop point.** `co located POCs unavailable` and
`mmco: unref short failure` appear each time `-stream_loop` wraps, because the
decoder sees a discontinuity. Cosmetic, and they stop existing once the source
is a real camera rather than a looping file.

## Adding a camera

One block in `cameras.yml`, then `python media/configure.py`:

```yaml
  - id: cam_new_post          # must match a camera row in backend/src/db/seed.ts
    label: BOP-05 New Post
    detect: true
    source:
      kind: file              # file | rtsp | webcam
      path: clips/new_post.mp4
```

A typo in `id` shows up as a worker that runs fine and produces no events —
the backend rejects frames for an unknown `camera_id`.
