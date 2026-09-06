four RTSP endpoints

rtsp://127.0.0.1:8554/cam_fence_north
rtsp://127.0.0.1:8554/cam_farm_gate
rtsp://127.0.0.1:8554/cam_patrol_road
rtsp://127.0.0.1:8554/cam_waterline

The path is the camera id, not the filename. clips/fence_north.mp4 is published as /cam_fence_north — that indirection is what lets you swap in a real camera later without anything downstream noticing.

The hub has to be running for these to exist:

media/bin/mediamtx.exe media/mediamtx.yml

Viewing them

ffplay rtsp://127.0.0.1:8554/cam_fence_north        # or VLC: Media > Open Network Stream
curl http://127.0.0.1:9997/v3/paths/list            # all four, ready=true

Same streams in a browser (WebRTC, not RTSP — browsers can't play RTSP):

http://127.0.0.1:8889/cam_fence_north
http://127.0.0.1:8889/cam_farm_gate
http://127.0.0.1:8889/cam_patrol_road
http://127.0.0.1:8889/cam_waterline

That's MediaMTX's own built-in reader page. The console at localhost:3000/live uses .../whep on the same port.

From another machine, replace 127.0.0.1 with the hub's LAN IP and set IBVAP_MEDIA_ADVERTISE_IP in .env to that same IP — otherwise WebRTC advertises Hyper-V/WSL adapters and the tile connects then stays black.

---

One thing to flag: those four files are still the synthetic test patterns I generated — all 20s, 854×480, identical sizes. If you meant you'd dropped your own footage in, it hasn't landed. To swap in your own:

# drop your file in, then point the manifest at it
copy my_gate_footage.mp4 media\clips\fence_north.mp4
python media/fetch.py --camera cam_fence_north --normalise   # re-encodes to WebRTC-safe H.264
python media/configure.py

The --force re-encode matters — it's what strips B-frames. A file copied in directly will publish to RTSP fine and show a black tile in the browser.

 Source → hub

MediaMTX starts and runs each path's runOnInit:

ffmpeg -re -stream_loop -1 -i "…/clips/fence_north.mp4" \
       -c:v copy -an -f rtsp -rtsp_transport tcp \
       rtsp://127.0.0.1:8554/cam_fence_north

- -re — read at native rate. Without it the file blasts through at hundreds of × real time.
- -c:v copy — no transcode, only safe because fetch.py already encoded H.264 Constrained Baseline with -bf 0.
- runOnInitRestart: yes — ffmpeg dies, MediaMTX respawns it.

Real camera instead: source: rtsp://admin:pass@10.0.0.14:554/Streaming/Channels/102. No ffmpeg process at all. Nothing downstream changes — same path name, same everything.

Stage 2 — Hub holds one copy

MediaMTX now has cam_fence_north ready with one H264 track, and serves it two ways from a single ingest:

┌──────┬──────────┬────────────────┐
│ Port │ Protocol │    Consumer    │
├──────┼──────────┼────────────────┤
│ 8554 │ RTSP     │ vision workers │
├──────┼──────────┼────────────────┤
│ 8889 │ WHEP     │ browsers       │
├──────┼──────────┼────────────────┤
│ 9997 │ HTTP API │ health checks  │
└──────┴──────────┴────────────────┘

This is the whole reason a hub exists: cheap IP cameras cap at 2–4 concurrent RTSP sessions, so browser and detector each pulling from the camera doesn't survive real hardware.