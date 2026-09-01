# IBVAP — Intelligent Border Video Analytics Platform

> This file is the single source of truth for this project. Read it fully before
> answering anything. It encodes constraints, settled decisions, and honesty
> rules that were argued out already. Do not silently override them.

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
  Never suggest CUDA, TensorRT, or GPU-only libraries.
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

## 4. SCOPE — TWO features only, right now

1. **Human detection + tracking** — detect persons, maintain identity across
   frames, output movement trails.
2. **Face detection** — locate faces as the *precondition* for later watchlist
   matching. **Detection only. No recognition.**

**Do NOT add** ANPR, vehicle classification, virtual fence, night-mode, or
"suspicious activity" until these two are measured and stable.
**5 reliable features beat 15 half-working ones.** If asked to add a feature,
push back and ask what evidence exists that the current two are done.

## 5. SETTLED ARCHITECTURE — do not change without being asked

| Choice | Reason | Never substitute |
|---|---|---|
| YOLO11n (nano) | only size leaving CPU headroom for a second stage | yolo11s/m/l |
| `classes=[0]` | person-only → cheaper NMS, no spurious boxes | all-class inference |
| ByteTrack | IoU + Kalman only, near-zero CPU cost | DeepSORT — runs a re-ID CNN per box per frame, fatal on CPU |
| `persist=True` | tracker must know frames form a sequence | omitting it resets IDs every call |
| YuNet (`cv2.FaceDetectorYN`) | ~230 KB ONNX, CPU-designed | MTCNN, RetinaFace-R50 |
| Cascaded face search | faces sought only in upper region of each person box | full-frame face detection |

### Why cascaded face detection is the main technical talking point
- **Compute:** search a few small head crops instead of 2.07 M pixels.
- **False positives:** eliminates face hallucinations on foliage, rocks, tyre
  treads, window reflections — *by construction*, not threshold tuning. A border
  scene is full of exactly those textures.
- **Attribution:** every face arrives already bound to a `track_id`, so
  watchlist matching runs **once per track, not once per frame**. This directly
  attacks operator alert fatigue, a real deployment failure mode.

### Frame policy in `core/ingest.py` — understand before editing
- Live source (RTSP / webcam) → `drop=True`, latest-frame-wins, bounded latency.
- File source → `drop=False`, backpressure, zero frame loss.
- `cv2.VideoCapture` buffers frames. If inference is slower than the camera FPS,
  that buffer grows and a "live" feed silently goes 90 s stale. This is the #1
  cause of collapsed hackathon video demos.
- Using `drop=True` on a *file* discarded ~97 % of frames and faked 22 camera
  "reconnects". **This bug already happened once and was fixed. Do not
  reintroduce it.**

## 6. KNOWN LIMITATIONS — state honestly, never hide

- **No re-identification.** ByteTrack has no appearance model. Long occlusion →
  a NEW track id. Short occlusion is recovered by its low-confidence
  association pass. **Never claim persistent re-ID.**
- **Face detection is resolution-bound.** A 60 px-tall person has a ~12 px face;
  no detector finds that. Faces work at **choke points** (gate, checkpost,
  doorway), not across open terrain. The working range must be measured in
  **metres** and reported.
- **YuNet does not identify anyone.** It outputs a box + 5 landmarks. The word
  "recognition" must never appear in any description of `core/face.py`.

## 7. EVIDENCE RULES — non-negotiable

- Never state an accuracy, latency, FPS, cost, or scalability figure that was
  not measured on team hardware. If unmeasured, write **"Not measured yet."**
- Numbers from any cloud sandbox are **invalid** for the PPT.
- Every performance claim records: machine, resolution, flags, and date.
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
  a jury would ask for.
- Readable over clever: **six people must each defend this code individually
  under hostile questioning.** SIH finals interrogate members separately.
- No new dependency without justification — each one is a laptop that fails to
  set up the night before submission.
- Windows-first instructions (venv, PowerShell). Project lives on the SSD.

## 10. LAYOUT

```
run.py            demo harness / CLI
core/ingest.py    RTSP + file ingest, source-aware frame policy
core/person.py    YOLO11n + ByteTrack, TrackHistory trails
core/face.py      cascaded YuNet, BestFacePerTrack
data/             videos + weights (git-ignored and claude-ignored)
```

## 11. RUN

```
python run.py --source data/test.mp4 --show
python run.py --source data/test.mp4 --show --imgsz 480 --detect-every 2 --face-every 10
python run.py --source rtsp://127.0.0.1:8554/cam1 --show
python run.py --source 0 --show --no-face
```

Tuning order when too slow: `--imgsz 480` → `--detect-every 2` → `--face-every 10`.
`--imgsz` is the biggest single win; it costs accuracy on small distant people.

## 12. NEXT TASKS (in order)

1. Confirm with the college SPOC: internal nomination status, real deadline,
   whether a demo video is mandatory, and the official PPT template
   (download **only** from sih.gov.in — third-party "SIH templates" online are
   SEO junk and a disqualification risk).
2. Download YuNet weights (~230 KB) using GitHub's **"Download raw file"** button.
   A plain right-click-save yields a 131-byte git-LFS pointer, not the model.
3. Measure baseline FPS and detector ms/call on **every** team laptop. Identify
   the strongest machine — that one records the demo video.
4. Record campus-gate clips: daylight, low light, and an **occlusion test**
   (person walks behind a pillar and returns).
5. Answer empirically: does the occluded person keep their track id? Record it.
6. Measure the face-detection working range in metres.
7. Only then decide on ONNX / OpenVINO export, based on real numbers.

## 13. HOW TO BEHAVE IN THIS REPO

Be blunt. If an idea is weak, say "this is weak" and explain why. Do not flatter.
Separate **fact / assumption / inference / recommendation**. Challenge feature
creep. Prefer demonstrability and defensibility over impressiveness. Ask "what
happens in real deployment?" — poor connectivity, camera failure, low light,
fog, dust, false positives, alert fatigue, storage, privacy, model drift.

Optimise for surviving a hostile jury and a real deployment discussion —
not for looking impressive.