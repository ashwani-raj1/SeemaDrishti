"""
Resolve the manifest's clip sources into files the media hub can loop.

    python media/fetch.py                        # fetch every missing clip
    python media/fetch.py --force                # re-fetch even if present
    python media/fetch.py --synthetic            # placeholder clips, no network
    python media/fetch.py --camera cam_farm_gate --url "https://..."

    # footage you already have
    python media/fetch.py --normalise                       # fix every clip in place
    python media/fetch.py --camera cam_farm_gate --normalise
    python media/fetch.py --camera cam_farm_gate --normalise ~/gate.mp4

WHY NORMALISE EVERY CLIP: the hub publishes with `-c:v copy`, which only
works if the file is already H.264. A clip that is VP9 or AV1 — which is
what most video sites hand you — would force MediaMTX to transcode on every
restart, spending exactly the CPU the detector needs. Encoding once here is
the whole reason `-c:v copy` is safe at runtime.

WHY --normalise EXISTS: dropping your own .mp4 into media/clips/ is the fastest
way to get real footage in, and the file will almost always be the wrong shape
for WebRTC. It publishes to RTSP, plays in VLC, negotiates in the browser, and
then the tile stays black. This runs that file through the same encode a
downloaded clip gets, and skips files that already conform so re-running it
costs nothing.

WHY CLIPS ARE TRIMMED BY DEFAULT: a two-hour source is gigabytes on disk for
footage that loops anyway. Two minutes of the right camera angle demonstrates
more than two hours of the wrong one.

ON SOURCING (see vision-service/claude.md §3): no real Indian border footage exists
publicly and it never will. Legitimate proxies are VIRAT Ground (closest
geometric match — fixed, high-mounted, person heights 10–200 px), MOT17/20
(ground-truth IDs, so ID switches become measurable), PETS2009, and
self-recorded campus-gate clips. This script takes whatever URL you give it
and does not ship any: licence terms vary per video, and §7 forbids asserting
a licence nobody checked. Check the terms of anything you download.

STATUS: prototype.
"""

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
MEDIA = ROOT / "media"
CLIPS = MEDIA / "clips"


def need(tool):
    if shutil.which(tool) is None:
        raise SystemExit(
            f"[fetch] `{tool}` is not on PATH.\n"
            f"        ffmpeg + yt-dlp are both installable with:\n"
            f"        choco install ffmpeg yt-dlp"
        )
    return tool


def run(cmd, what):
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        tail = (result.stderr or result.stdout or "").strip().splitlines()[-6:]
        print(f"[fetch] {what} FAILED")
        for line in tail:
            print(f"        {line}")
        return False
    return True


def load_manifest():
    manifest = yaml.safe_load((MEDIA / "cameras.yml").read_text(encoding="utf-8"))
    defaults = manifest.get("defaults") or {}
    out = []
    for cam in manifest.get("cameras") or []:
        merged = dict(defaults)
        merged.update(cam)
        out.append(merged)
    return manifest, out


def normalise(src, dst, height, seconds):
    """
    One encode, to the one format the runtime path can copy without work.

    -pix_fmt yuv420p   the only chroma format every browser decodes. A source
                       in yuv444p plays in VLC and shows nothing in Chrome.
    -bf 0              NO B-FRAMES. WebRTC cannot carry them: the hub accepts
                       the stream, the browser negotiates fine, the peer
                       connection establishes -- and then the session closes
                       with "WebRTC doesn't support H264 streams with
                       B-frames". libx264 emits them by default, so a clip
                       encoded without this flag plays perfectly in VLC and
                       shows a black tile in the console. Measured here, not
                       theorised.
    -profile:v baseline  belt and braces: baseline forbids B-frames outright,
                       and is the H.264 profile every browser decodes.
    -g 50              keyframe every ~2s. WebRTC cannot start a stream until
                       it sees a keyframe, so a sparse-keyframe clip makes a
                       tile take many seconds to appear.
    scale=-2:H         -2 keeps the aspect ratio and forces an even width,
                       which libx264 requires.
    """
    need("ffmpeg")
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    if seconds:
        cmd += ["-t", str(seconds)]
    cmd += ["-i", str(src)]
    if height:
        cmd += ["-vf", f"scale=-2:{height}"]
    cmd += [
        "-c:v", "libx264", "-preset", "medium", "-crf", "23",
        "-profile:v", "baseline", "-level", "3.1",
        "-pix_fmt", "yuv420p", "-g", "50", "-bf", "0",
        "-an", "-movflags", "+faststart",
        str(dst),
    ]
    return run(cmd, f"encode -> {dst.name}")


def probe(path):
    """
    What the runtime path actually cares about, straight from the file.

    Cheaper than re-encoding to find out, and it is the difference between
    "your clip is already fine" and a needless generation of quality loss.
    """
    if shutil.which("ffprobe") is None:
        return None
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=codec_name,profile,has_b_frames,pix_fmt",
         "-of", "json", str(path)],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        return None
    try:
        streams = json.loads(result.stdout).get("streams") or []
    except json.JSONDecodeError:
        return None
    return streams[0] if streams else None


def conforms(path):
    """
    Is this file already what the hub can `-c:v copy` and a browser can play?

    Three things, and B-frames is the one that costs a day: a clip with them
    publishes to RTSP fine, plays in VLC fine, negotiates in the browser fine,
    and then the session closes and the tile stays black.

    Returns (ok, reason). `None` reason means we could not tell -- no ffprobe --
    and the caller should encode rather than assume.
    """
    info = probe(path)
    if info is None:
        return False, None

    wrong = []
    if info.get("codec_name") != "h264":
        wrong.append(f"codec is {info.get('codec_name')}, not h264")
    if info.get("has_b_frames"):
        wrong.append("has B-frames, which WebRTC cannot carry")
    if info.get("pix_fmt") != "yuv420p":
        wrong.append(f"pixel format is {info.get('pix_fmt')}, not yuv420p")

    return (not wrong), ", ".join(wrong)


def normalise_in_place(dst, height, seconds):
    """
    Re-encode a clip that is already sitting at its destination.

    ffmpeg cannot read and write the same file, so this goes via a temp beside
    it and replaces on success -- a failed encode must not destroy the footage
    somebody just dropped in.
    """
    temp = dst.with_name(dst.stem + ".normalising.mp4")
    if not normalise(dst, temp, height, seconds):
        temp.unlink(missing_ok=True)
        return False
    temp.replace(dst)
    return True


def download(url, workdir):
    need("yt-dlp")
    workdir.mkdir(parents=True, exist_ok=True)
    for stale in workdir.glob("src.*"):
        stale.unlink()
    ok = run(
        ["yt-dlp", "--no-playlist", "-f", "bv*[height<=720]/b[height<=720]/b",
         "-o", str(workdir / "src.%(ext)s"), url],
        f"download {url[:60]}",
    )
    if not ok:
        return None
    got = list(workdir.glob("src.*"))
    return got[0] if got else None


def synthetic(dst, height, seconds, label):
    """
    A placeholder so the media path can be proved end to end with no network.

    HONEST LIMIT: this exercises hub -> WHEP -> browser and hub -> worker
    decode. It does NOT exercise detection — YOLO will not find a person in
    a test pattern, and it should not. Real footage is required before any
    detection claim means anything.
    """
    need("ffmpeg")
    text = label.replace(":", "\\:").replace("'", "")
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", f"testsrc2=size=854x{height}:rate=25",
        "-t", str(seconds),
        "-vf",
        (f"drawtext=text='{text}':fontcolor=white:fontsize=28:x=20:y=20:"
         f"box=1:boxcolor=black@0.6:boxborderw=8,"
         f"drawtext=text='SYNTHETIC — plumbing only, not detectable':"
         f"fontcolor=yellow:fontsize=18:x=20:y=h-40:"
         f"box=1:boxcolor=black@0.6:boxborderw=6"),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
        "-profile:v", "baseline", "-level", "3.1",
        "-pix_fmt", "yuv420p", "-g", "50", "-bf", "0",
        "-an", "-movflags", "+faststart",
        str(dst),
    ]
    return run(cmd, f"synthesise -> {dst.name}")


def set_url(camera_id, url):
    """Write a url back into the manifest, so the next run is reproducible."""
    path = MEDIA / "cameras.yml"
    manifest = yaml.safe_load(path.read_text(encoding="utf-8"))
    for cam in manifest.get("cameras") or []:
        if cam.get("id") == camera_id:
            cam.setdefault("source", {})["url"] = url
            path.write_text(
                yaml.safe_dump(manifest, sort_keys=False, width=10_000),
                encoding="utf-8",
            )
            print(f"[fetch] recorded url for {camera_id} in cameras.yml")
            print("        NOTE: comments in cameras.yml are lost on rewrite.")
            return True
    raise SystemExit(f"[fetch] no camera `{camera_id}` in cameras.yml")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="re-fetch clips that exist")
    ap.add_argument("--synthetic", action="store_true",
                    help="generate placeholder clips instead of downloading")
    ap.add_argument("--camera", help="operate on one camera only")
    ap.add_argument("--url", help="set this camera's source url, then fetch it")
    ap.add_argument("--normalise", "--normalize", nargs="?", const=True, default=None,
                    metavar="PATH", dest="normalise",
                    help="re-encode footage you already have. With PATH, copies that "
                         "file into the camera's slot; without, fixes the clip already "
                         "in place. Skips files that already conform unless --force")
    ap.add_argument("--seconds", type=int, default=120,
                    help="trim to this many seconds (0 = keep all)")
    args = ap.parse_args()

    if args.url:
        if not args.camera:
            raise SystemExit("[fetch] --url needs --camera")
        set_url(args.camera, args.url)

    # A path names one file, so it needs one camera to be the destination.
    # Bare --normalise is a sweep and is happy to do the whole manifest.
    if isinstance(args.normalise, str) and not args.camera:
        raise SystemExit("[fetch] --normalise PATH needs --camera")

    _, cameras = load_manifest()
    if args.camera:
        cameras = [c for c in cameras if c.get("id") == args.camera]
        if not cameras:
            raise SystemExit(f"[fetch] no camera `{args.camera}`")

    CLIPS.mkdir(parents=True, exist_ok=True)
    work = MEDIA / ".work"
    done, skipped, failed = 0, 0, 0

    for cam in cameras:
        source = cam.get("source") or {}
        if source.get("kind", "file") != "file":
            continue

        dst = MEDIA / source["path"]
        dst.parent.mkdir(parents=True, exist_ok=True)
        height = cam.get("height")

        # --normalise runs before the have-it-already check: the whole point is
        # that the file IS there and is the wrong shape.
        if args.normalise is not None:
            src = Path(args.normalise) if isinstance(args.normalise, str) else dst

            if not src.exists():
                print(f"[fetch] {cam['id']:<18} no file at {src}")
                failed += 1
                continue

            ok, why = conforms(src)
            if ok and not args.force:
                print(f"[fetch] {cam['id']:<18} {src.name} already conforms - nothing to do")
                skipped += 1
                continue
            if why:
                print(f"[fetch] {cam['id']:<18} {why}")
            elif why is None and not args.force:
                print(f"[fetch] {cam['id']:<18} no ffprobe - encoding rather than assuming")

            encoded = (
                normalise_in_place(dst, height, args.seconds)
                if src == dst
                else normalise(src, dst, height, args.seconds)
            )
            done += encoded
            failed += (not encoded)
            continue

        if dst.exists() and not args.force:
            print(f"[fetch] {cam['id']:<18} have {dst.name}")
            skipped += 1
            continue

        if args.synthetic:
            ok = synthetic(dst, height or 480, args.seconds or 20,
                           cam.get("label", cam["id"]))
        elif source.get("url"):
            raw = download(source["url"], work)
            ok = normalise(raw, dst, height, args.seconds) if raw else False
        else:
            print(f"[fetch] {cam['id']:<18} no url — add one to cameras.yml, "
                  f"or drop a file at {dst.relative_to(MEDIA)}")
            skipped += 1
            continue

        done += ok
        failed += (not ok)

    if work.exists():
        shutil.rmtree(work, ignore_errors=True)

    print(f"\n[fetch] {done} fetched, {skipped} skipped, {failed} failed")
    if done:
        print("[fetch] now run: python media/configure.py")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
