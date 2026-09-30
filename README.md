# SeemaDrishti

**Intelligent border video analytics that runs at the post, not in a cloud.**

SeemaDrishti turns the ordinary IP CCTV already installed at Border Out Posts, check posts and border roads into an intelligent surveillance network, with no GPU, no new cameras and no cloud dependency. It watches every feed, judges virtual-fence crossings, reads number plates, tracks people, and turns what matters into incidents an operator can act on. It records every human decision in a tamper-evident log and lets investigators ask questions in plain language.

Built for **Smart India Hackathon 2026 · Problem Statement 26187** (Ministry of Home Affairs / Sashastra Seema Bal).

> **Thesis:** existing analytics products assume good hardware, power and bandwidth, and a Border Out Post has none of those. SeemaDrishti is built for what is actually there: a commodity CPU box, existing cameras and an unreliable uplink.

## Explanation video

> 🎬 **Coming soon.** *(placeholder: add the video link here)*

## High-level architecture

![SeemaDrishti high-level architecture](docs/hld.png)

- **Cameras → Media server:** each camera is pulled **once** over RTSP by MediaMTX, which fans the stream out to every reader. The browser gets WebRTC and the vision service gets RTSP.
- **Vision service:** one YOLO11n + ByteTrack pass per frame is shared by pluggable modules (fence, ANPR, multi-human, face watchlist). It sends **live observations** to the console over WebSocket (can be dropped) and **durable events** to the backend over HTTP (retried, never lost).
- **Backend:** the system of record. It judges events against zones, groups them into incidents, stores operator decisions in a hash-chained audit log, and pushes state to the console over SSE. Everything lives in one local SQLite file.
- **Frontend:** the operator console, with live view, alerts, configuration and chat.
- **MCP server + Investigation agent:** an LLM agent answers questions like *"why didn't the north fence alarm last night?"* through read-only MCP tools over the backend. A local Ollama model can be used when data can't leave the site.

> **Key principle:** the vision service owns *realtime observation*, and the backend owns *durable truth* and *operator decisions*.


## Incident Reporting Flow

![SeemaDrishti Incident Reporting Flow](docs/incident_reporting_flow.png)

### Where it started

Our first brainstorm sketch (25 August), the idea before the code:

![First brainstorm sketch](docs/brainstorm-sketch.png)

The core split was there from day one: a source-agnostic media hub, a Python vision service that only detects, and an edge service where all operator actions and data stay. Some things changed on the way. The `ibvap/service` box became `vision-service/`, and the Gemini main agent with sub-agents became the ADK investigation agent over the MCP server, running on any OpenRouter model.

## Repository map

| Folder | What it does | Docs |
|---|---|---|
| [`backend/`](backend) | Edge node: virtual fence, events, incidents, audit log, REST + SSE on SQLite (Bun + Express) | [README](backend/README.md) |
| [`frontend/`](frontend) | Operator console: dashboard, incidents, maps, zones, watchlists (React + Tailwind) | [README](frontend/README.md) |
| [`vision-service/`](vision-service) | CPU-only detection pipeline: YOLO11n + ByteTrack, fence, ANPR, people, face (Python) | [README](vision-service/README.md) |
| [`media/`](media) | Video hub: MediaMTX config, camera manifest, clip fetching (RTSP / WebRTC) | [README](media/README.md) |
| [`mcp/`](mcp) | MCP server exposing backend data as 21 read-only tools for AI agents (Go) | [README](mcp/Readme.md) |
| [`agent/`](agent) | AI investigation assistant that answers operator questions through MCP (Google ADK) | [README](agent/README.md) |

Also: [`docs/`](docs) has the API reference, guidelines, ER diagram and HLD; [`plans/`](plans) has design briefs and flow write-ups.

## Screenshots

### Operator console

<table>
<tr>
<td width="50%"><img src="docs/screenshots/dashboard.png" alt="Dashboard"><br><sub><b>Dashboard</b>: live cameras, KPIs and priority detections</sub></td>
<td width="50%"><img src="docs/screenshots/dashboard-map-analytics.png" alt="Dashboard map and analytics"><br><sub><b>Sector overview</b>: map, event feed and 24h analytics</sub></td>
</tr>
<tr>
<td><img src="docs/screenshots/incidents.png" alt="Incidents"><br><sub><b>Incidents</b>: grouped detections with severity and status</sub></td>
<td><img src="docs/screenshots/sector-map.png" alt="Sector map"><br><sub><b>Sector map</b>: where tonight's incidents happened</sub></td>
</tr>
<tr>
<td><img src="docs/screenshots/virtual-fence.png" alt="Virtual fence"><br><sub><b>Virtual fence</b>: live feed, active alert, acknowledge / escalate</sub></td>
<td><img src="docs/screenshots/virtual-fence-stats.png" alt="Virtual fence stats"><br><sub><b>Fence analytics</b>: intrusions, crossings, confirm-hold times</sub></td>
</tr>
<tr>
<td><img src="docs/screenshots/plate-watchlist.png" alt="Plate watchlist"><br><sub><b>Plate watchlist</b>: live ANPR with flagged vehicles</sub></td>
<td><img src="docs/screenshots/anpr-analytics.png" alt="ANPR analytics"><br><sub><b>ANPR breakdown</b>: OCR confidence, traffic and vehicle types</sub></td>
</tr>
<tr>
<td><img src="docs/screenshots/people-tracking.png" alt="People tracking"><br><sub><b>People tracking</b>: single- or multi-camera tracking</sub></td>
<td><img src="docs/screenshots/audit-trail.png" alt="Audit trail"><br><sub><b>Audit trail</b>: every decision, hash-chained and verifiable</sub></td>
</tr>
<tr>
<td><img src="docs/screenshots/anpr-incident.png" alt="ANPR watchlist incident"><br><sub><b>Watchlist hit</b>: flagged plate with captured proof, match details and recommended action</sub></td>
<td><img src="docs/screenshots/person-recognition.png" alt="Person search"><br><sub><b>Person search</b>: closest candidate shown with its score; below the 75% threshold it is not claimed as a match</sub></td>
</tr>
<tr>
<td><img src="docs/screenshots/cameras.png" alt="Cameras"><br><sub><b>Cameras</b>: feed health and service status</sub></td>
<td><img src="docs/screenshots/zones.png" alt="Zones"><br><sub><b>Zones</b>: named places, watching cameras, target policy</sub></td>
</tr>
</table>

### Investigation agent

<table>
<tr>
<td width="33%"><img src="docs/screenshots/agent-chat.png" alt="Agent chat"><br><sub>Asking about cameras and fence crossings</sub></td>
<td width="33%"><img src="docs/screenshots/agent-investigation.png" alt="Agent investigation"><br><sub>Investigation grounded in MCP tool calls</sub></td>
<td width="33%"><img src="docs/screenshots/agent-critical-alerts.png" alt="Agent critical alerts"><br><sub>"Any critical alerts in the last 20 mins?"</sub></td>
</tr>
</table>

## Tech stack

| Area | Technologies |
|---|---|
| 🎥 **Media server** | **MediaMTX** (one RTSP ingest per camera, served out as RTSP and WebRTC), **FFmpeg** (video processing) |
| 🧑‍💻 **Languages** | Python, TypeScript (Node / Bun), Go |
| 👁️ **Vision service** | **YOLO11** (Ultralytics), ByteTrack, OpenCV, YuNet face detection, EasyOCR (ANPR) |
| 🖥️ **Frontend** | React + TypeScript, Tailwind CSS, Zustand (state), React Router, React-Leaflet (maps) |
| 🗄️ **Backend** (system of record) | Bun, Express (REST API), SQLite (database) |
| 🔌 **MCP server** | Go, `net/http`, `mcp-go` (mark3labs) |
| 🧠 **Investigation agent** | TypeScript, Google ADK (`@google/adk`), MCP SDK, OpenRouter (LLM gateway); optional local Ollama (Llama, Qwen, Mistral, Gemma) |
| 🔗 **Protocols** | RTSP, WebRTC, WHEP (WebRTC-HTTP Egress Protocol), WebSocket, HTTP, SSE, MCP, TLS |

## Quick start

Requires [Bun](https://bun.com) 1.3+, Python 3.11, FFmpeg, and optionally Go (MCP) and Node (agent).

```powershell
git clone https://github.com/ashwani-raj1/SeemaDrishti.git
cd SeemaDrishti
Copy-Item .env.example .env

bun run setup                                # installs backend + frontend
python media\fetch.py --synthetic            # or point media/cameras.yml at real footage
python media\configure.py

media\bin\mediamtx.exe media\mediamtx.yml    # 1: media hub
bun run dev                                  # 2: backend :8000 + console :3000
python vision-service\main.py                # 3: vision service
```

Optional AI investigation: `cd mcp && go run .` (`:13000`), then `cd agent && npm run web` (`:3080`).

On first boot the backend seeds `backend/ibvap.db` with a demo site, cameras and zones. To produce incidents without a camera, open **Simulator** in the console. Everything it generates is flagged `SIMULATED`. Run the tests with `bun run test` (backend + frontend) and `python -m pytest vision-service/tests`.

| Service | Port |
|---|---|
| Console | `3000` |
| Backend (REST + SSE) | `8000` |
| Vision live channel (WS) | `8100` |
| ANPR / people APIs | `8001` / `8002` |
| Media hub (RTSP / WebRTC / API) | `8554` / `8889` / `9997` |
| MCP server | `13000` |
| Agent (dev UI / API) | `3080` / `4080` |

## Team

**Tech Fungus**

| Name | LinkedIn |
|---|---|
| Aditya Raj | [LinkedIn](#) |
| Harsh Raj Shukla | [LinkedIn](#) |
| Ashwani Raj | [LinkedIn](#) |
| Priyanshu Roushan | [LinkedIn](#) |
| Anamika | [LinkedIn](#) |
| Mansi | [LinkedIn](#) |
