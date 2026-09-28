"""
Generate the media hub config from the camera manifest.

    python media/configure.py           # write media/mediamtx.yml
    python media/configure.py --check   # validate only, change nothing

WHY GENERATE IT: the ffmpeg line that loops a clip into MediaMTX is long,
easy to get subtly wrong, and identical for every camera. Hand-writing it
four times is four chances to typo `-re` (without which ffmpeg pushes the
whole file through in seconds and the "camera" runs at several hundred x
real time). The manifest stays short and readable; this file owns the
verbosity.

WHY THIS MODULE HAS ITS OWN .env READER: media/ is a separately deployable
module. It runs on whichever machine hosts MediaMTX, which may have no
Python vision dependencies installed at all. Importing from ibvap/ would
couple two things that are meant to be able to live on different boxes.
Twenty duplicated lines is the cheaper side of that trade.

STATUS: prototype.
"""

import argparse
import os
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
MEDIA = ROOT / "media"


# ─────────────────────────────────────────────────────────── env

def load_env(path=None):
    """
    Minimal .env reader. Real environment variables win over the file, so a
    one-off `set IBVAP_MEDIA_HOST=... && python configure.py` still works.
    """
    path = path or (ROOT / ".env")
    values = {}
    if path.exists():
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip().strip('"').strip("'")
    values.update({k: v for k, v in os.environ.items() if k.startswith("IBVAP_")})
    return values


def env(values, key, default=""):
    got = values.get(key, "")
    return got if got != "" else default


# ─────────────────────────────────────────────────────────── manifest

def load_manifest():
    manifest = yaml.safe_load((MEDIA / "cameras.yml").read_text(encoding="utf-8"))
    defaults = manifest.get("defaults") or {}
    cameras = manifest.get("cameras") or []

    resolved = []
    for cam in cameras:
        merged = dict(defaults)
        merged.update(cam)
        if not merged.get("id"):
            raise SystemExit("[configure] a camera block has no `id`")
        if not merged.get("source"):
            raise SystemExit(f"[configure] {merged['id']}: no `source` block")
        resolved.append(merged)

    seen = set()
    for cam in resolved:
        if cam["id"] in seen:
            raise SystemExit(f"[configure] duplicate camera id {cam['id']}")
        seen.add(cam["id"])
    return resolved


# ─────────────────────────────────────────────────────────── path building

def ffmpeg_publish(input_args):
    """
    The publish line shared by every non-RTSP source.

    -re          read at native frame rate. WITHOUT THIS ffmpeg pushes the
                 file through as fast as it can decode and every downstream
                 timestamp is nonsense.
    -c:v copy    no transcode. Requires the clip to already be H.264, which
                 is what fetch.py guarantees. Transcoding here would spend
                 the CPU the detector needs.
    -an          drop audio. Nothing in this system consumes it, and it is
                 one more thing for WebRTC to negotiate.
    """
    return (
        "ffmpeg -hide_banner -loglevel error "
        f"{input_args} "
        "-c:v copy -an -f rtsp -rtsp_transport tcp "
        "rtsp://127.0.0.1:$RTSP_PORT/$MTX_PATH"
    )


def path_entry(cam, problems):
    source = cam["source"]
    kind = source.get("kind", "file")

    if kind == "rtsp":
        url = source.get("url")
        if not url:
            problems.append(f"{cam['id']}: source.kind is rtsp but no `url`")
            return {"source": "publisher"}
        # MediaMTX pulls this itself — no ffmpeg, no transcode, and the
        # credentials in the URL stay on this machine.
        return {"source": url, "sourceOnDemand": False}

    if kind == "webcam":
        device = source.get("device")
        if not device:
            problems.append(f"{cam['id']}: source.kind is webcam but no `device`")
            return {"source": "publisher"}
        # dshow cannot be copied — it is raw frames, so this one path does
        # have to encode. ultrafast/zerolatency keeps it affordable.
        return {
            "runOnInit": (
                "ffmpeg -hide_banner -loglevel error "
                f'-f dshow -i video="{device}" '
                "-c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p "
                # -bf 0: WebRTC cannot carry B-frames (see media/fetch.py).
                # zerolatency already implies it; stated so a future edit
                # to the preset cannot silently reintroduce them.
                "-profile:v baseline -bf 0 "
                "-an -f rtsp -rtsp_transport tcp "
                "rtsp://127.0.0.1:$RTSP_PORT/$MTX_PATH"
            ),
            "runOnInitRestart": True,
        }

    # kind == "file"
    clip = source.get("path")
    if not clip:
        problems.append(f"{cam['id']}: source.kind is file but no `path`")
        return {"source": "publisher"}

    resolved = (MEDIA / clip) if not Path(clip).is_absolute() else Path(clip)
    if not resolved.exists():
        hint = " — run `python media/fetch.py`" if source.get("url") else ""
        problems.append(f"{cam['id']}: clip missing at {resolved}{hint}")

    # Forward slashes: ffmpeg accepts them on Windows and they survive the
    # shell that MediaMTX runs this through without backslash escaping.
    as_posix = resolved.as_posix()
    return {
        "runOnInit": ffmpeg_publish(f'-re -stream_loop -1 -i "{as_posix}"'),
        "runOnInitRestart": True,
    }


# ─────────────────────────────────────────────────────────── output

HEADER = """\
# GENERATED by media/configure.py — do not edit.
#
# Edit media/cameras.yml (what cameras exist) or .env (where modules run),
# then re-run:  python media/configure.py
"""


def build(values, cameras, problems):
    bind = env(values, "IBVAP_MEDIA_BIND", "0.0.0.0")
    rtsp_port = env(values, "IBVAP_RTSP_PORT", "8554")
    whep_port = env(values, "IBVAP_WHEP_PORT", "8889")
    advertise = env(values, "IBVAP_MEDIA_ADVERTISE_IP", "")

    paths = {cam["id"]: path_entry(cam, problems) for cam in cameras}

    # Start exactly ONE shared vision process when the first detectable media
    # path becomes ready. That process reads the same manifest and handles all
    # cameras selected by IBVAP_WORKER_CAMERAS (normally `all`). Attaching one
    # worker per path would load YOLO/EasyOCR repeatedly and overwhelm a
    # CPU-only deployment.
    launcher = next((cam for cam in cameras if cam.get("detect", True)), None)
    if launcher is not None:
        python = Path(sys.executable).resolve().as_posix()
        vision = (ROOT / "ibvap" / "main.py").resolve().as_posix()
        paths[launcher["id"]]["runOnReady"] = (
            f'"{python}" "{vision}" '
            # Individual plate-facing cameras can override this in cameras.yml
            # without making all six workers pay the higher inference cost.
            "--cameras all --imgsz 384 --target-fps 2"
        )
        # If the detector crashes while the media path remains healthy,
        # MediaMTX brings it back. MediaMTX also terminates the managed command
        # when the hub stops, so no orphan per-camera workers are left behind.
        paths[launcher["id"]]["runOnReadyRestart"] = True

    # The Plate Watchlist's uploaded-video and shared-camera modes intentionally
    # use the same high-quality request/response ANPR pipeline. Start that one
    # local API once as another MediaMTX-managed service; it is not a per-camera
    # process. A second ready path owns the hook because MediaMTX exposes one
    # runOnReady command per path.
    anpr_launcher = next(
        (cam for cam in cameras
         if cam.get("detect", True) and (launcher is None or cam["id"] != launcher["id"])),
        None,
    )
    if anpr_launcher is not None:
        python = Path(sys.executable).resolve().as_posix()
        app_dir = (ROOT / "ibvap").resolve().as_posix()
        paths[anpr_launcher["id"]]["runOnReady"] = (
            f'"{python}" -m uvicorn ai_service:app '
            f'--app-dir "{app_dir}" --host 127.0.0.1 --port 8001'
        )
        paths[anpr_launcher["id"]]["runOnReadyRestart"] = True

    config = {
        "logLevel": "info",
        "logDestinations": ["stdout"],

        "api": True,
        "apiAddress": f"{bind}:9997",

        "rtsp": True,
        "rtspAddress": f"{bind}:{rtsp_port}",
        # TCP only: UDP RTSP on a busy Windows box drops packets and the
        # decoder produces grey macroblocks that look like a model failure.
        "rtspTransports": ["tcp"],

        "webrtc": True,
        "webrtcAddress": f"{bind}:{whep_port}",
        "webrtcAllowOrigins": ["*"],
        # The browser is handed these IPs to connect back on. Auto-gathering
        # picks up Hyper-V / WSL / VirtualBox adapters on a Windows laptop
        # and the tile connects then stays black; IBVAP_MEDIA_ADVERTISE_IP
        # settles it.
        "webrtcAdditionalHosts": [advertise] if advertise else [],

        # Off on purpose. Each listener is a port to explain and a service to
        # secure, and nothing in this system reads them.
        "hls": False,
        "rtmp": False,
        "srt": False,
        "moq": False,

        "paths": paths,
    }
    return config


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="validate and report, write nothing")
    args = ap.parse_args()

    values = load_env()
    cameras = load_manifest()
    problems = []
    config = build(values, cameras, problems)

    out = MEDIA / "mediamtx.yml"
    if not args.check:
        out.write_text(
            HEADER + yaml.safe_dump(config, sort_keys=False, width=10_000),
            encoding="utf-8",
        )

    host = env(values, "IBVAP_MEDIA_HOST", "127.0.0.1")
    rtsp_port = env(values, "IBVAP_RTSP_PORT", "8554")
    whep_port = env(values, "IBVAP_WHEP_PORT", "8889")

    print(f"[configure] {len(cameras)} camera(s)")
    for cam in cameras:
        mark = "detect" if cam.get("detect") else "video only"
        print(f"  {cam['id']:<18} {cam['source'].get('kind','file'):<7} {mark}")
    print()
    print(f"  workers pull   rtsp://{host}:{rtsp_port}/<camera_id>")
    print(f"  browsers pull  http://{host}:{whep_port}/<camera_id>/whep")

    if problems:
        print(f"\n[configure] {len(problems)} problem(s):")
        for p in problems:
            print(f"  ! {p}")
        print("\n  Paths are still written. A camera whose clip is missing")
        print("  simply has no video until the clip appears.")

    if not args.check:
        print(f"\n[configure] wrote {out}")
    return 1 if (problems and args.check) else 0


if __name__ == "__main__":
    sys.exit(main())
