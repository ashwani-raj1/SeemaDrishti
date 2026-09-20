# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# IBVAP — Intelligent Border Video Analytics Platform

> This file is the single source of truth for this project. Read it fully before
> answering anything. It encodes constraints, settled decisions, and honesty
> rules that were argued out already. Do not silently override them.
>
> Section numbers are cited from code comments (`requirements.txt` §9,
> `modules/reid.py` §7). **Do not renumber.**

---

## 1. WHAT THIS IS

Smart India Hackathon 2026 entry.
**Problem Statement 26187** — Ministry of Home Affairs / **Sashastra Seema Bal
(SSB), Police II Division**. Category: Software.
Portal theme tag: "Blockchain & Cybersecurity" (this tag does NOT match the
description — see §8).

**The ask, verbatim in substance:** an AI software platform that turns
*existing* standard IP CCTV at Border Out Posts (BOPs), check posts and border
roads into an intelligent surveillance network — **without** buying dedicated
FRS / ANPR / smart-camera hardware.

Capabilities the PS lists: human detection & tracking, vehicle detection &
classification, face detection, ANPR, virtual fence intrusion, suspicious
activity detection, night-time movement detection, real-time alerts + event
logging, integration with existing command & control.

**What they are trying to escape:** conventional CCTV that only records and
requires a human to stare at it continuously.

### The line this service sits on

**The vision service owns realtime observation. The edge node owns durable
truth and operator decisions.** That sentence decides every argument about where
a piece of logic belongs.

`ibvap/` therefore DOES evaluate fence geometry — a crossing has to be judged
against the frame it happened in, at the rate frames arrive, and shipping every
box to another process to be judged would be both slower and less accurate. What
it does **not** do is decide what a crossing *means*. Severity, whether a human
is woken, and whether this is a person to alarm about or a cow to write down
follow the zone's **targets**, which a supervisor edits on the console, which
the node stores and audits.

So the wire carries a fact — *"person crossed zone_3 inbound, held 1.4 s"* — and
the node applies the policy. If this service also chose severity, changing a
zone from WARNING to CRITICAL would mean pushing config to every worker laptop
before the change took effect, and the audit log would describe an edit that had
not happened yet.

This service never writes a database, never learns that an operator
acknowledged anything, and never receives a command.

---

## 2. SITUATION — read this before proposing anything ambitious

- **Team:** 6 members, mixed skill, **no prior model training experience**.
- **Timeline:** roughly 2 weeks from end of Aug 2026. Deadline reported as
  20 or 30 September 2026 — UNVERIFIED, must be confirmed with the college SPOC.
- **Current stage:** SIH round 1 = **idea/PPT submission**, submitted by the
  college SPOC (students cannot submit directly to the national portal).
- A **demonstration video may be mandatory** for the Software Edition, and it
  must NOT be AI-generated (neither footage nor voice narration). UNVERIFIED —
  confirm on sih.gov.in. Plan as if it is required.
- **Time is the scarcest resource.** Every suggestion must be costed in hours.

## 3. HARD CONSTRAINTS — never violate

- **NO GPU.** Nobody on the team has an NVIDIA GPU. All inference is CPU-only.
  Never suggest CUDA, TensorRT, or GPU-only libraries. `SharedDetector` is
  constructed with `device="cpu"` and `easyocr.Reader` with `gpu=False` at every
  call site — keep it that way.
  Primary dev machine: Lenovo IdeaPad S145, **Ryzen 3** (~2 cores / 4 threads,
  15 W class), 12 GB RAM, Windows on SSD. Treat this as the floor.
- **NO physical IP camera.** Test inputs are: video files, laptop webcam, and
  **RTSP simulated locally** via MediaMTX + FFmpeg looping a file. The pipeline
  cannot tell simulated RTSP from a real camera — that is the point.
- **NO real Indian border/BOP footage exists publicly** and it never will
  (operationally sensitive). Anyone claiming otherwise is wrong.
  Legitimate proxies: **VIRAT Ground** (fixed high-mounted outdoor cameras,
  person heights 10–200 px — closest geometric match), MOT17/MOT20 (has
  ground-truth IDs, so ID switches can actually be measured), PETS2009,
  FLIR ADAS / KAIST multispectral (for IR/night, check licences),
  YouTube CCTV clips via yt-dlp, and **self-recorded campus-gate footage**.
  Do NOT use unauthorised public camera aggregator sites (e.g. Insecam).
- **CPU budget is the design constraint, not accuracy.** A feature that pushes
  the pipeline below usable FPS is a regression, not a feature.

## 4. SCOPE — one shared pass, three pluggable modules

One long-running process hosts multiple detection sub-modules. **One detection
pass (YOLO11n + ByteTrack) runs per frame per camera, and its output is handed
to every active module.** A module that runs its own detector has misunderstood
the design — three modules each detecting independently is three times the only
cost that actually matters, for the same boxes three times over.

| Module | Does | Durable output |
|---|---|---|
| `fence` | zone polygon intrusion + line crossing, debounce, cooldown | `intrusion` |
| `anpr` | plate crop → OCR inside a tracked vehicle box | `plate_read` |
| `multi_human` | within-camera person tracking; re-ID is interface-only (§6) | `reidentification` |

Which modules run is per camera, in `media/cameras.yml`. Adding a capability is
a new file in `modules/` plus a name in that manifest — **the dispatcher, the
WebSocket server and the HTTP sink do not change.** That is the test of whether
this layer is actually pluggable.

The person-tracking and YuNet face-detection modules that predated this
refactor were deleted; they are in git history (`core/person.py`,
`core/face.py`) and face detection would return as a module, not as a
special case.

**5 reliable features beat 15 half-working ones.** If asked for loitering
detection, night mode or "suspicious activity", push back and ask what evidence
exists that fence and ANPR are measured and stable. Note that loitering is a
*rule over this module's output*, not a new way of detecting people — it belongs
in a new module reading the same shared pass.

## 5. SETTLED ARCHITECTURE — do not change without being asked

| Choice | Reason | Never substitute |
|---|---|---|
| YOLO11n (nano) | only size leaving CPU headroom for a second stage | yolo11s/m/l |
| One shared pass per frame | modules are consumers of detections, not producers | per-module detectors |
| `classes` = person, vehicles, boat, dog, cow | exactly the vocabulary a zone's targets are written in (`backend/src/db/seed.ts`); animals ride the same pass for free and are what `log_only` exists for | all-class inference |
| ByteTrack | IoU + Kalman only, near-zero CPU cost | DeepSORT — runs a re-ID CNN per box per frame, fatal on CPU |
| `persist=True` | tracker must know frames form a sequence | omitting it resets IDs every call |
| One tracker **per camera** | ByteTrack state lives on the model object; one shared tracker interleaves N unrelated scenes into one association problem and produces constant id switches | a single global detector |
| EasyOCR on a cropped plate region | plate text read after the vehicle is localised, so a vehicle with no readable plate is still a valid detection | full-frame OCR, or a second plate-detection model |
| Capped cadence (`IBVAP_TARGET_FPS`) | the overlay reads as live at 5–10 fps; the detector does a fraction of the work | running at stream rate |

### Why cascaded plate OCR is the main technical talking point
- **Compute:** OCR runs on the lower-centre slice of an already-tracked vehicle
  box (`PlateReader.plate_region`, `lower_frac=0.45`, `center_w_frac=0.60`), not
  across 2.07 M pixels. OCR is far more expensive than YOLO here, so this is the
  difference between a usable pipeline and a slideshow.
- **False positives:** plate hallucinations on signage, foliage and reflections
  are excluded *by construction*, not by threshold tuning. The plausibility gate
  reinforces it rather than replacing it: a read is accepted only at 6–12 chars,
  confidence ≥ 0.45, containing **both** a letter and a digit.
- **Attribution:** every read arrives already bound to a track, so a watchlist
  check happens once per vehicle rather than once per frame. That is a direct
  attack on operator alert fatigue, a real deployment failure mode.

### Fence confirm — why two clocks, not one
The spec asks for N consecutive confirming frames. A zone carries
`confirm_seconds`, set by a supervisor who thinks in seconds. Counted in frames
alone, the same setting silently means four times longer on a slower laptop;
counted in seconds alone, a stalled stream can "hold" a crossing while showing
one frozen image. A crossing confirms only when it survives **both**. Cooldown
is per `(track, zone, direction)` — walking in and walking back out are two
facts, and collapsing them loses the exit an investigator went looking for.

**A side is tri-state, and 0 is not a side.** `side_for_zone` returns +1, -1 or
**0** — the last meaning "on the line, within EPSILON", i.e. no side established
yet. Both `crossing_of` and the pending-crossing machine in `modules/fence.py`
must treat 0 as undetermined: no crossing is reported *onto* side 0, and a
pending crossing seeing 0 holds rather than counting it as a reversal. Getting
this wrong is not theoretical — it shipped. The old code ended
`return "inbound" if after == 1 else "outbound"`, so a subject landing exactly on
a horizontal line was reported **outbound regardless of travel**, and the next
frame's genuine crossing was then discarded as flicker. The subject walked
through and **nothing was emitted**, while the run summary showed a rejected
flicker — a missed intrusion wearing the costume of the debounce working.
Ground points are pixel-quantised (`ny1 + nh`), so on a 480-row frame exactly one
row in 480 triggers it. `tests/test_geometry.py` and `tests/test_fence.py` both
pin the regression.

`core/geometry.py` is a deliberate port of `backend/src/l2/geometry.ts`. Same
conventions, same epsilon, same inbound/outbound definition. **Change a rule in
one and change it in the other**, or a zone means one thing to the console's
preview and another to the detector judging it. The node keeps its copy because
the simulator still posts raw detections through `/hooks/ingress/detections` —
and note its rejection path *emits a durable event*, so a bug like the one above
writes a false "did not persist" record into the permanent log rather than just
dropping a crossing.

### Frame policy in `core/capture.py` — understand before editing
- Live source (RTSP / webcam) → `drop=True`, latest-frame-wins, bounded latency.
- File source → `drop=False`, backpressure, zero frame loss.
- `cv2.VideoCapture` buffers frames. At a capped cadence against a 25 fps stream
  inference is *always* slower than the source, so that buffer grows and a
  "live" feed silently goes 90 s stale. This is the #1 cause of collapsed
  hackathon video demos.
- Using `drop=True` on a *file* discarded ~97 % of frames and faked 22 camera
  "reconnects". **This bug already happened once and was fixed. Do not
  reintroduce it.** `drop=None` auto-selects per source; do not "simplify" it to
  one behaviour.

### The same latest-wins rule, in two places — and its deliberate exception
`core/capture.py` (live sources) and `LiveChannel`'s per-client queue of 1
(drop-oldest) implement one policy: **a stale frame or box is worse than none,
and a slow consumer must never apply backpressure to the detection loop.**

`DurableSink` is the exception and it is the whole point of the split: it
**retries with backoff and drains on shutdown**, because a confirmed intrusion
is worth exactly as much five seconds late as it was when it happened. It sheds
only when 512 events have banked up, and says so in the run summary rather than
losing them quietly.

## 6. KNOWN LIMITATIONS — state honestly, never hide

- **No re-identification, today.** `modules/reid.py` ships the interface and
  `NullReID`, which returns "I don't know" for every crop. ByteTrack has no
  appearance model, so a long occlusion produces a NEW track id and a subject
  walking between cameras has no relationship to themselves. **Never claim
  persistent re-ID, and never describe a tracker id as an identity** — the
  naming rule is written into the bottom of `modules/reid.py`.
  `ai_service.py::stable_track_key` stitches ids across HTTP frames using IoU +
  normalised centre distance; that is a geometric heuristic scoped to one
  browser session, not re-ID.
- **Plate OCR is resolution-bound.** A plate occupying a few pixels cannot be
  read reliably. It works at a **gate or checkpoint** where plates face the
  camera, not across a wide open scene — which is why `anpr` is enabled per
  camera in the manifest rather than everywhere. The working range must be
  measured in **metres** on the installed camera and reported.
- **Threads, not processes.** One asyncio task per camera with CPU work pushed
  through `asyncio.to_thread`. That works while the GIL is released inside
  ultralytics/OpenCV native code, which is where nearly all the time goes. It is
  NOT enough for many cameras on one box: threads then contend for the same
  cores and each camera's rate falls roughly in proportion. The answer at that
  point is a process per camera, not a bigger thread pool — and the honest first
  answer is one worker per laptop via `IBVAP_WORKER_CAMERAS`.
- **No throughput figure is quoted anywhere** — none has been measured on team
  hardware. `main.py` prints the real numbers at exit; those are the only ones
  worth repeating.

## 7. EVIDENCE RULES — non-negotiable

- Never state an accuracy, latency, FPS, cost, or scalability figure that was
  not measured on team hardware. If unmeasured, write **"Not measured yet."**
- Numbers from any cloud sandbox are **invalid** for the PPT.
- Every performance claim records: machine, resolution, flags, and date.
- `main.py --seconds N` exists precisely for this: same clip, same flags, same
  duration, one comparable row per laptop.
- Do not invent SIH rules, government requirements, dataset licences, or
  research findings. If something is time-sensitive or uncertain, say so and
  say what needs verifying.

## 8. STRATEGIC POSITIONING — the thesis everything supports

PS 26187 already has mature commercial competitors selling software-only video
analytics to Indian police/paramilitary. SSB has almost certainly seen vendor
demos. **The guaranteed first jury question is: "This exists commercially — why
build it, why not procure it?"** "We used AI" loses.

**Thesis:** *Existing analytics products assume good hardware, good power and
good bandwidth. BOPs have none of those. We build the version that runs on what
is actually there.*

The no-GPU constraint is therefore an **asset, not an excuse** — BOPs have no
GPUs either. Positioning: "runs on a commodity CPU box, not a GPU server."

Supporting differentiators (all checkable, none buzzwords):
- Offline-first at the BOP; only events + thumbnails sync upstream, never video.
- Commodity edge hardware, with cost-per-camera computed from real prices.
- Night/IR treated as a first-class case, not an afterthought.
- Composite **rule-based** events (loitering / dwell / direction violation)
  instead of vague "suspicious activity AI" — operator-tunable, explainable.
- **Tamper-evident hash-chained event log** for evidentiary integrity. This is
  the honest way to satisfy the portal's "Blockchain & Cybersecurity" theme tag
  **without shoehorning in a blockchain.** (Legal grounding under electronic
  evidence provisions needs verification before it goes on a slide.)

### Forbidden in slides, docs, or code comments
Feature dumping · unsourced statistics · "95 % accuracy" style claims ·
generic AI buzzwords as a substitute for real innovation · architecture diagrams
where every box says "AI Engine" · the word "recognition" for detection-only code.

## 9. CODE CONVENTIONS

- Label every module `STATUS: prototype` or `STATUS: production-ready`.
- Comment the **why**, not the what. Every non-obvious choice carries the reason
  a jury would ask for. The existing docstrings are long on purpose — match that
  density rather than trimming it.
- Readable over clever: **six people must each defend this code individually
  under hostile questioning.** SIH finals interrogate members separately.
- No new dependency without justification — each one is a laptop that fails to
  set up the night before submission. `requirements.txt` carries the reason each
  line is not removable, plus a "NOT listed, on purpose" section for the ones
  deliberately absent (`python-dotenv`, an async HTTP client, `numpy`, a ReID
  model). Keep both current.
- **A module returns `(live, durable)` and names no transport. A transport names
  no module.** That separation is what keeps the plug-in layer real.
- asyncio for structure, threads for the CPU-bound parts. The event loop must
  never be held by a YOLO call or a socket — `asyncio.to_thread` both.
- Windows-first instructions (venv, PowerShell). Project lives on the SSD.

## 10. LAYOUT

```
main.py                entrypoint: capture → shared pass → modules → both sinks
config.py              .env + cameras.yml + zones pulled from the node
ai_service.py          FastAPI /detect for the browser plate scanner (port 8001)
run-anpr.ps1           installs requirements, launches ai_service under uvicorn

core/capture.py        RTSPStream — threaded reader, latest frame, reconnect
core/detection.py      SharedDetector — the ONE YOLO11n + ByteTrack pass
core/geometry.py       point-in-polygon / line side / crossing (port of l2/geometry.ts)
core/payload.py        LiveObservation + DurableEvent schemas and builders
core/dispatcher.py     LiveChannel (WS fanout) + DurableSink (HTTP, retry)

modules/base.py        VisionModule interface + REGISTRY
modules/fence.py       zone + line crossing, debounce, per-direction cooldown
modules/anpr.py        PlateReader + AnprModule
modules/multi_human.py within-camera person tracking, re-ID hook
modules/reid.py        ReIDProvider interface, NullReID, Gallery

data/                  videos + weights (git-ignored and claude-ignored)
yolo11n.pt             detector weights; downloads itself on first run
```

Outside this directory, same repo, one layer up:

```
../media/cameras.yml        WHAT cameras exist + which modules each runs — committed
../.env                     WHERE modules run + what THIS box does — per-machine, ignored
../backend/src/l4/vision.ts the durable ingress this service posts to
../backend/src/l2/fence.ts  the node's own fence, still used by the simulator
../frontend/src/lib/live.ts  the console's live overlay client
```

`config.py` resolves `ROOT` as the **repo root**, one level up — so
`../media/cameras.yml` and `../.env` are found regardless of which directory the
process was launched from.

## 11. RUN

Python 3.11, separate from the Bun workspace — `bun run setup` does **not**
install this.

```powershell
python -m pip install -r requirements.txt
```

**`main.py`** — the vision service.

```powershell
python main.py                           # cameras from IBVAP_WORKER_CAMERAS
python main.py --cameras cam_farm_gate
python main.py --no-backend              # live channel only, nothing recorded
python main.py --seconds 60              # comparable baseline row per laptop (§7)
python main.py --imgsz 384 --target-fps 4
```

**`ai_service.py`** — local HTTP plate scanner for the console. `GET /health`,
`POST /detect` with `{"image": "<data URL or base64 JPEG>"}`. CORS is open only
to `localhost:3000`. It imports `core.*` and `modules.*` as siblings, so it
**must** be launched from inside `ibvap/`:

```powershell
.\run-anpr.ps1                           # installs deps, then uvicorn on :8001
python -m uvicorn ai_service:app --host 127.0.0.1 --port 8001
```

Full system, three terminals from the repo root:

```powershell
python media/fetch.py --synthetic      # or point cameras.yml at real footage
python media/configure.py
media/bin/mediamtx.exe media/mediamtx.yml   # terminal 1 — media hub
bun run dev                                  # terminal 2 — node + console
python ibvap/main.py                         # terminal 3 — vision service
```

Start the node **before** the vision service when you can: zones come from
`/api/config`. If it is down, fence modules start with no zones, say so on
stdout, and pick the zones up within `IBVAP_ZONE_REFRESH_SECONDS` of it
returning — no restart needed.

Tuning order when too slow: `--imgsz 384` → lower `--target-fps` → fewer
cameras per machine. `--imgsz` is the biggest single win and it costs accuracy
on small distant subjects and plates — state that trade out loud rather than
discover it on stage.

### Tests
```powershell
python -m pip install -r requirements-dev.txt   # pytest, and nothing else
python -m pytest tests/                          # 36 tests, under a second
```

`tests/test_geometry.py` and `tests/test_fence.py` cover `core/geometry.py` and
`modules/fence.py` — the two worth testing first, because both are pure
functions over numbers and need no camera. No model, no network, no weights — a
test that downloads a checkpoint is a test that fails on a demo laptop, which is
also why pytest lives in `requirements-dev.txt` and not in `requirements.txt`.
Anything new goes under `tests/` as `test_<module>.py` and keeps that property.

Beyond the unit tests, verification is still running `main.py` against a short
clip and reading the run summary it prints at exit. The backend has its own
suite (`cd backend && bun test`, 99 tests) and it must stay green.

## 12. NEXT TASKS (in order)

1. Confirm with the college SPOC: internal nomination status, real deadline,
   whether a demo video is mandatory, and the official PPT template
   (download **only** from sih.gov.in — third-party "SIH templates" online are
   SEO junk and a disqualification risk).
2. ~~Migrate `frontend/src/lib/boxes.ts` to the `LiveObservation` contract and
   delete `core/payload.legacy_box_frame` with it (§14).~~ **DONE.** `boxes.ts`
   was replaced by `frontend/src/lib/live.ts` and `legacy_box_frame` is gone;
   neither name appears anywhere in the code. Kept in place rather than
   renumbered, because the section numbers are cited from code comments.
3. Measure baseline FPS and detector ms/call on **every** team laptop with
   `main.py --seconds N`. Identify the strongest machine — that one records the
   demo video.
4. Record campus-gate clips: daylight, low light, and an **occlusion test**
   (subject passes behind a pillar and returns).
5. Answer empirically: does the occluded subject keep its track id? Record it.
6. Measure the plate-OCR working range in metres.
7. Only then decide on a ReID model, ONNX / OpenVINO export, or a process per
   camera — each on real numbers.

## 13. HOW TO BEHAVE IN THIS REPO

Be blunt. If an idea is weak, say "this is weak" and explain why. Do not flatter.
Separate **fact / assumption / inference / recommendation**. Challenge feature
creep. Prefer demonstrability and defensibility over impressiveness. Ask "what
happens in real deployment?" — poor connectivity, camera failure, low light,
fog, dust, false positives, alert fatigue, storage, privacy, model drift.

Optimise for surviving a hostile jury and a real deployment discussion —
not for looking impressive.

## 14. THE TWO CONTRACTS — not one shape with two destinations

```
RTSP ─> capture ─> ONE YOLO11n+ByteTrack pass ─> fence ───────┐
        latest-    per camera                    anpr         ├─> LiveObservation
        frame-wins                               multi_human ─┘   WS :8100 → console
                                                              └─> DurableEvent
                                                                  HTTP :8000 → node
```

Both channels carry what the same frame produced, and that is where the
similarity ends.

| | Live (WS) | Durable (HTTP) |
|---|---|---|
| Contains | boxes, tracks, unconfirmed guesses | confirmed intrusions, accepted plate reads, camera health |
| Rate | every processed frame | seconds to minutes apart |
| On a slow consumer | **drop** | **queue and retry with backoff** |
| Stored | never | always, by the node |
| Authoritative | no | yes |

If a confirmed intrusion went out over the websocket *and* to the node in
parallel, a slow console or a failed POST would produce alerts visible live but
absent from history, duplicates on reconnect, operator decisions taken against
events that were never persisted, and two consoles disagreeing. Splitting the
contract in two prevents all of it by construction: **nothing durable is ever
only in a browser.** The console must treat the node's own rebroadcast — not a
message from here — as authoritative, even when it saw the live version first.

### 1. LiveObservation → console

```json
{ "camera_id": "cam_fence_north", "module": "fence", "kind": "live",
  "frame_ts": 91821.44,
  "tracks": [ { "track_id": 7, "bbox": [0.44, 0.52, 0.55, 0.79],
                "confidence": 0.86, "class": "person",
                "extra": { "trail": [[0.5, 0.4]], "zones": [ ... ] } } ] }
```

One message **per module per frame**, so a console can draw the fence overlay
without parsing ANPR's guesses. `extra` is the module-specific transient slot: a
live plate guess, a trajectory tail, a pending-crossing flag. Nothing in `extra`
may reach the durable path.

**The migration shim is gone** (§12.2). The console speaks `LiveObservation`
only, through `frontend/src/lib/live.ts`; the old `{"t": "boxes"}` shape and
`core/payload.legacy_box_frame` were deleted together, so there is once again
exactly one live contract.

### 2. DurableEvent → `POST /hooks/ingress/events`

```json
{ "camera_id": "cam_fence_north", "module": "fence", "event_type": "intrusion",
  "track_id": 7, "timestamp": 91821.44,
  "occurred_at": "2026-09-13T02:14:00.000Z", "simulated": false,
  "source_id": "vision.a1b2",
  "data": { "track_ref": "a1b2:7", "class": "person", "zone_id": "zn_3",
            "direction": "inbound", "rule": "zone.crossing.confirmed",
            "bbox": [0.44, 0.52, 0.11, 0.27], "crossed_at": [0.50, 0.79],
            "path": [[0.5, 0.4]], "held_seconds": 1.4, "held_frames": 4,
            "confirm_seconds": 0.8, "confirm_frames": 3 } }
```

`event_type` is one of `intrusion`, `plate_read`, `camera_health`,
`reidentification`. `backend/src/l4/vision.ts` is the handler.

- **`bbox` is `[x, y, w, h]`, normalised 0–1, top-left corner** on the durable
  side; the live side uses `[x1, y1, x2, y2]`, also normalised. `SharedDetector`
  produces every form once, in one place — two functions producing "the box" is
  how a system ends up with two conventions, and a wrongly-converted box still
  looks like a box. The failure is silent.
- The subject's ground point is the **bottom centre** of the box. Using the
  centre would make a subject cross a line half a body-height early.
- **`data.track_ref` is `{run_id}:{track_id}`.** ByteTrack reuses integer ids
  once a track dies and restarts from 1 on process restart; the node keys
  `tracked_thing` on `(camera_id, track_ref)` with a UNIQUE constraint, so a
  bare id lets a new subject inherit a dead one's record. A detection with no
  track id yet is **dropped, not sent**.
- **`timestamp`** is producer-monotonic seconds. It cannot step backwards when
  the host clock is corrected, which is what every held-time measurement counts
  on. Malformed values are rejected rather than coerced — a `NaN` in a clock
  silently poisons every duration computed from it.
- **`simulated`** is set once, at the adapter, from the manifest's source kind
  (`kind: file` → true). The console renders a **SIMULATED** badge from it.
- **`camera_id` must already be seeded** in `backend/src/db/seed.ts` or the node
  rejects the event. A typo in `cameras.yml` shows up as a worker that runs fine
  and produces zero events.
- Two doors exist on the node and they are not the same door.
  `/hooks/ingress/detections` takes raw per-frame detections and judges them
  with `l2/fence.ts` — the **simulator** posts there. `/hooks/ingress/events`
  takes already-confirmed events. Do not collapse them.

## 15. CONFIGURATION — three sources, deliberately not merged

| | Answers | Lifetime |
|---|---|---|
| `../media/cameras.yml` | **what** cameras exist, and which modules each runs | committed, shared |
| `../.env` | **where** modules run, and what **this** box does | per-machine, gitignored |
| the node's `/api/config` | **zones**, as the operator currently has them drawn | live, re-read while running |

Every machine reads the same manifest and a different `IBVAP_WORKER_CAMERAS` —
that is what makes one-worker-per-laptop work.

**Zones come from the node, not from a file, and this matters.** Fence
evaluation runs here, but a zone is drawn and edited by a supervisor on the
console, stored by the node, and audited there. If zones lived in a YAML file in
this directory, an operator editing one would change nothing until someone SSH'd
into every worker laptop — and the audit trail would describe an edit that never
took effect. `config.py` polls `/api/config` every
`IBVAP_ZONE_REFRESH_SECONDS`; an edit reaches the detector judging it within one
interval, by itself. This service never synthesises a shape of its own.

**Two shapes it will nonetheless judge against, both labelled.** The rule that
matters is not "only ever judge against a confirmed shape" — it is **never judge
silently against geometry whose currency cannot be vouched for.** Two cases
qualify, and each one travels with its own flag so the node can record the
crossing and refuse to alert on it:

- **`provisional`** — a camera added to a zone gets a stock placeholder shape
  (`l3/zones.ts:placeholderShape`) and `placed = 0` until a supervisor draws it.
  The node now sends that as `provisional: true` on `/api/config`, this service
  carries it into the event, and `l4/vision.ts` records the crossing with
  `alertable = 0` and `suppressed_reason = "zone_not_placed"`. Before this was
  labelled, undrawn placeholders produced **fully alertable** intrusions against
  geometry nobody had positioned — the exact thing this section forbids, and it
  had been happening quietly.
- **`stale`** — a last-good zone cache, read **only at startup** and **only when
  the node is unreachable**, keyed by backend URL. Every zone from it is marked
  `stale` with the time it was written, and the node suppresses with
  `suppressed_reason = "zone_cache_stale"`. This **reverses** the old absolute
  "it does not cache a stale shape". The reason for the reversal: a detector
  that goes blind on a node restart records nothing at all, and nothing is the
  one outcome nobody can review afterwards. Note the ceiling — if the node is
  down the events cannot be delivered either, so `DurableSink` banks 512 and
  sheds the newest beyond that. The run summary says how many.

In both cases **severity stays on the node**. This service reports a fact and a
label; it never decides that a crossing is not worth alerting on (§1, §14).

| Variable | Default | Meaning |
|---|---|---|
| `IBVAP_WORKER_CAMERAS` | `all` | Which cameras *this* machine runs detection on |
| `IBVAP_MEDIA_HOST` / `IBVAP_RTSP_PORT` | `127.0.0.1` / `8554` | Where the media hub is |
| `IBVAP_BACKEND_HOST` / `IBVAP_BACKEND_PORT` | `127.0.0.1` / `8000` | Where the edge node is |
| `IBVAP_BOXES_BIND` / `IBVAP_BOXES_PORT` | `0.0.0.0` / `8100` | Where the console reads live observations |
| `IBVAP_WEIGHTS` | `yolo11n.pt` | Detector weights |
| `IBVAP_IMGSZ` | `480` | Inference size |
| `IBVAP_CONF` | `0.35` | Confidence floor |
| `IBVAP_TARGET_FPS` | `6` | Processed frames per second, per camera |
| `IBVAP_ZONE_REFRESH_SECONDS` | `15` | How often zones are re-read from the node |

Real environment variables beat the `.env` file. `main.py`'s
`--cameras/--imgsz/--target-fps` work by writing into `os.environ` *before*
`Settings()` is constructed — keep that order.

A camera with `detect: false` is never returned by `load_cameras()`: it still
has video in the hub and a live tile on the console, it just has no boxes. That
is a real state the console shows honestly, not a failure. A name in
`IBVAP_WORKER_CAMERAS` absent from the manifest is a hard `SystemExit`, not a
silent no-op.

### Per-camera module config

```yaml
defaults:
  modules: [fence, multi_human]      # cheap: arithmetic over the shared pass

cameras:
  - id: cam_farm_gate
    modules: [fence, anpr, multi_human]    # ANPR is opt-in: it loads EasyOCR
  - id: cam_waterline
    modules:                               # the mapping form takes params
      fence: { confirm_frames: 4, cooldown_seconds: 30 }
```

Module params are documented in each module's `configure()`. Fence **zones** are
never written here — see above.
