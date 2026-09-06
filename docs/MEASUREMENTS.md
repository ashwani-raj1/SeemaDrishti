# Measured numbers

claude.md §7: never state an FPS, latency or accuracy figure that was not
measured on team hardware. Every row here records machine, resolution, flags
and date. **If a number is not in this file, it may not go in the PPT.**

Reproduce any row with:

```powershell
python ibvap/service.py --seconds 40            # all cameras in .env
python ibvap/service.py --cameras cam_fence_north --seconds 30
```

---

## M1 — worker scaling on one machine

**Machine:** Intel Core i5-10310U @ 1.70 GHz, 4 cores / 8 threads, 15.8 GB RAM,
Windows 11 Pro. CPU-only (torch 2.11.0+cpu).
**Model:** YOLO11n, `classes=[0]`, ByteTrack, `persist=True`.
**Flags:** `imgsz=480`, `detect_every=2`, `conf=0.35`.
**Source:** synthetic test-pattern clips, 854×480 @ 25 fps, looped over RTSP.
**Date:** 2026-09-06.

| Workers | fps / camera | detector ms/call | source drop | aggregate fps |
|--:|--:|--:|--:|--:|
| 1 | 20.8 | 66.1 | 9 % | 20.8 |
| 4 | 8.6 – 9.1 | 185.7 – 191.5 | 62 – 64 % | ~35.3 |

**What this says.** Four workers on one box nearly tripled per-call detector
time (66 → 189 ms) because they contend for the same cores. Total throughput
still rose (20.8 → ~35 fps aggregate), so the machine was not saturated at one
worker — but each individual camera got less responsive, and the source drop
rate went from 9 % to ~63 %.

**Is ~8.8 fps per camera usable?** For a walking person, yes: at 1.5 m/s that is
about 17 cm of travel between detector calls, well inside what ByteTrack
associates. The drop rate is `drop=True` doing its job — bounded latency, old
frames discarded — not a fault.

### The caveat that matters most

**This machine is not the floor.** claude.md §3 names a Lenovo IdeaPad S145,
Ryzen 3, ~2 cores / 4 threads, 15 W, as the hardware to design against. This
i5-10310U has twice the cores and a higher power budget. **Four workers on the
S145 will not produce these numbers** and should be expected to be substantially
worse.

Do not quote the four-worker row as a general claim. Re-run M1 on every team
laptop before it goes anywhere near a slide.

---

## M2 — per-laptop baseline

**Not measured yet.** claude.md §12.3 asks for this on *every* team machine, to
find the strongest one — that is the machine that records the demo video.

Run the same two commands as M1 and add a row:

| Machine | CPU | cores/threads | 1 worker fps | detector ms | 4 worker fps | Date |
|---|---|--:|--:|--:|--:|---|
| _(this dev box)_ | i5-10310U | 4/8 | 20.8 | 66.1 | ~8.8 | 2026-09-06 |
| IdeaPad S145 | Ryzen 3 | 2/4 | — | — | — | — |
| | | | | | | |

---

## M3 — detection quality

**Not measured yet, and cannot be measured with the current clips.** The
synthetic test patterns contain no people; every run above recorded **0
detections and 0 events posted**, which is correct behaviour, not a fault.

Everything below needs real footage first (see `media/README.md`):

- Person detection rate at BOP-like camera geometry
- ID-switch rate across an occlusion (claude.md §12.5 — does the occluded
  person keep their track id?)
- Face-detection working range **in metres** (§12.6)
- False-positive rate on foliage, rocks, and tyre treads

---

## M4 — end-to-end path checks

Not performance figures — pass/fail verifications of the live path, recorded so
a regression is visible.

| Check | Result | Date |
|---|---|---|
| Hub publishes 4 paths, H264, `-c:v copy` (no transcode) | pass | 2026-09-06 |
| RTSP → worker decode → YOLO → WS box channel | pass | 2026-09-06 |
| `capture_mono` drives the confirm window with wall clock frozen | pass | 2026-09-06 |
| Confirmed crossing recorded at 2.9 s held against a 2 s window | pass | 2026-09-06 |
| Backend suite | 68 pass / 0 fail | 2026-09-06 |
| Console typecheck (`src/`) | 0 errors | 2026-09-06 |
| WHEP tile playing in Chrome, 4 tiles | pass | 2026-09-06 |
| Zone overlay drawn over live video | pass | 2026-09-06 |

### Found while verifying the tile

**WebRTC cannot carry H.264 B-frames.** The first attempt showed four black
tiles reading "stream dropped". The hub log gave the reason:

```
[WebRTC] [session ca805bba] peer connection established, ... 1 track (H264)
[WebRTC] [session ca805bba] closed: WebRTC doesn't support H264 streams with B-frames
```

`libx264` emits B-frames by default, so the clips encoded fine, played fine in
VLC, and produced a black tile in the browser — the session established and
then closed a second later. Fixed by encoding
`-profile:v baseline -bf 0` in `media/fetch.py`; verified with
`ffprobe ... -show_entries stream=profile,has_b_frames` → `Constrained Baseline,0`.

This applies to real cameras too. Many IP cameras emit B-frames on the main
stream; substreams usually do not. Check before blaming the console.

### Browser load

Four WHEP tiles decoding **while four vision workers ran on the same machine**
froze the Chrome renderer hard enough that screenshots timed out at 30 s. With
the vision service stopped, four tiles rendered fine. Not quantified, and this
i5 is above the team floor — but it is a real limit and it argues for running
workers on separate machines rather than beside the console.
