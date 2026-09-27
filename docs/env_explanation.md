media/cameras.yml = what cameras exist
  .env            = where services are running + what this machine should process
  backend DB      = zones/events/incidents/operator actions

  Media Hub
  These tell MediaMTX where to serve video.

  IBVAP_MEDIA_HOST=127.0.0.1
  IBVAP_RTSP_PORT=8554
  IBVAP_WHEP_PORT=8889
  IBVAP_MEDIA_BIND=0.0.0.0
  IBVAP_MEDIA_ADVERTISE_IP=

  Used by:

  - media/configure.py
  - ibvap/config.py
  - backend /api/config, through backend/src/core/env.ts

  Meaning:

  - IBVAP_MEDIA_HOST: address clients use to reach MediaMTX.
  - IBVAP_RTSP_PORT: vision service pulls camera streams from rtsp://host:8554/camera_id.
  - IBVAP_WHEP_PORT: browser pulls live video from http://host:8889/camera_id/whep.
  - IBVAP_MEDIA_BIND: address MediaMTX binds to. 0.0.0.0 means reachable from LAN.
  - IBVAP_MEDIA_ADVERTISE_IP: WebRTC helper. Leave empty on one machine. Set to LAN IP if browser video connects but stays black.

  Example video path:

  Vision worker: rtsp://127.0.0.1:8554/cam_fence_north
  Browser:       http://127.0.0.1:8889/cam_fence_north/whep

  Backend / Edge Node

  IBVAP_BACKEND_HOST=127.0.0.1
  IBVAP_BACKEND_PORT=8000
  IBVAP_DB=ibvap.db

  Meaning:

  - IBVAP_BACKEND_HOST: used by the vision service to post durable events to backend.
  - IBVAP_BACKEND_PORT: backend listens on this port, and vision service posts to this port.
  - IBVAP_DB: SQLite database path.

  Important nuance: backend port is used here:

  const PORT = Number(process.env.IBVAP_BACKEND_PORT ?? 8000);

  So if you change IBVAP_BACKEND_PORT=9000, backend starts on 9000.

  The backend receives:

  POST /hooks/ingress/detections
  POST /hooks/ingress/events

  and frontend listens to backend changes through:

  GET /api/stream

  Live Boxes Channel

  IBVAP_BOXES_BIND=0.0.0.0
  IBVAP_BOXES_PORT=8100
  IBVAP_BOXES_HOST=127.0.0.1

  This is not the backend stream.

  This is the vision service WebSocket for temporary live overlays: boxes, tracks, pending fence crossings, plate guesses.

  Meaning:

  - IBVAP_BOXES_BIND: where the vision service binds its WebSocket.
  - IBVAP_BOXES_PORT: WebSocket port.
  - IBVAP_BOXES_HOST: what the browser should connect to.

  Backend exposes this to the frontend through /api/config as:

  boxesUrl: `ws://${boxesHost}:${boxesPort}`

  So the frontend gets both:

  Backend durable stream: /api/stream
  Vision live boxes:      ws://127.0.0.1:8100
  Video:                  http://127.0.0.1:8889/<camera>/whep

  What This Machine Processes

  IBVAP_WORKER_CAMERAS=all

  This controls which cameras the Python vision service processes on this machine.

  Examples:

  IBVAP_WORKER_CAMERAS=all
  IBVAP_WORKER_CAMERAS=cam_fence_north
  IBVAP_WORKER_CAMERAS=cam_farm_gate,cam_patrol_road

  Verified in ibvap/config.py:239. If you name a camera that does not exist in media/cameras.yml, the vision service exits loudly.

  CPU / AI Budget

  IBVAP_TARGET_FPS=6
  IBVAP_IMGSZ=480
  IBVAP_CONF=0.35
  IBVAP_WEIGHTS=yolo11n.pt
  IBVAP_ZONE_REFRESH_SECONDS=15

  Meaning:

  - IBVAP_TARGET_FPS: processed frames per second per camera. Camera may be 25/30 fps, but AI runs at 6 fps.
  - IBVAP_IMGSZ: inference image size. Lower is faster, worse for small/far objects.
  - IBVAP_CONF: detection confidence threshold.
  - IBVAP_WEIGHTS: YOLO weights file.
  - IBVAP_ZONE_REFRESH_SECONDS: how often vision service re-fetches zones from backend /api/config.

  This matters because zones are not stored in .env; zones are drawn in frontend, stored in backend, then pulled by vision.

  Vars Used By Code But Missing From .env.example

  These are real, but not listed in the example:

  IBVAP_DEBUG=1
  IBVAP_LOG=dev
  IBVAP_CLIENT_CONFIG=./client.json
  IBVAP_MEDIA_API_PORT=9997
  PORT=3000
  NODE_ENV=production

  Quick meaning:

  - IBVAP_DEBUG=1: enables developer reset route /api/admin/reset.
  - IBVAP_LOG=dev|combined|off: backend request log format.
  - IBVAP_CLIENT_CONFIG: frontend deployment config file.
  - IBVAP_MEDIA_API_PORT: MediaMTX control API port, default 9997.
  - PORT: frontend server port, default 3000.
  - NODE_ENV=production: disables frontend dev/HMR behavior.