"""
What this machine runs, and with what.

Three sources, deliberately not merged, because they answer different questions
and have different lifetimes:

    media/cameras.yml   WHAT cameras exist, and which modules each one runs
                        shared, committed
    .env                WHERE the modules run, and what THIS box does
                        per-machine, gitignored
    the edge node       ZONES, as the operator currently has them drawn
                        live, authoritative, re-read while running

That split is what makes one-worker-per-laptop work: every machine reads the
same manifest and a different IBVAP_WORKER_CAMERAS. Adding a camera is one
block in the manifest; moving the node to another box is one line in .env.

ZONES COME FROM THE NODE, NOT FROM A FILE, AND THIS MATTERS.
Fence evaluation runs in this process, but a zone is drawn and edited by a
supervisor on the console, stored by the node, and audited there. If zones
lived in a YAML file here, an operator editing one would change nothing until
someone SSH'd into every worker laptop — and the audit trail would describe an
edit that never took effect. So this service polls the node's own
`/api/config` and re-applies what it finds. An operator's edit reaches the
detector judging it within one refresh interval, by itself.

Until the node is reachable, a camera with a fence module simply has no zones
and says so at startup. It never guesses a shape.

ONE EXCEPTION, ADDED DELIBERATELY: a last-good cache, used only at startup and
only when the node is unreachable. Every zone it returns is marked `stale`,
that mark travels with the event, and the node records those crossings without
alerting on them. The guarantee the original rule protected is intact — nothing
is ever judged against geometry whose currency cannot be vouched for, silently.
What changed is the fallback: a detector that goes blind on a node restart
records nothing at all, and nothing is the one outcome nobody can review later.
See "the last-good zone cache" at the bottom of this file.

STATUS: prototype.
"""

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
MEDIA = ROOT / "media"

#: What a camera runs when its manifest block says nothing. Fence and
#: multi_human are cheap — they are arithmetic over the shared pass. ANPR is
#: not: it loads EasyOCR and reads pixels, so it is opt-in per camera, which
#: also happens to be honest about where plate reading actually works (a gate
#: or checkpoint, not across open terrain).
DEFAULT_MODULES: dict[str, dict] = {"fence": {}, "multi_human": {}}


def load_env(path: Path | None = None) -> dict[str, str]:
    """
    Minimal .env reader — deliberately not python-dotenv.

    No new dependency without justification: each one is a laptop that fails to
    set up the night before submission. This is fifteen lines and has no
    failure mode worth a package. Real environment variables win over the file,
    so a one-off override on the command line still works.
    """
    path = path or (ROOT / ".env")
    values: dict[str, str] = {}
    if path.exists():
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip().strip('"').strip("'")
    values.update({k: v for k, v in os.environ.items() if k.startswith("IBVAP_")})
    return values


class Settings:
    def __init__(self, env: dict[str, str] | None = None):
        self._env = env if env is not None else load_env()

    def get(self, key: str, default: Any = "") -> str:
        got = self._env.get(key, "")
        return got if got != "" else default

    def int_(self, key: str, default: int) -> int:
        try:
            return int(self.get(key, default))
        except (TypeError, ValueError):
            return default

    def float_(self, key: str, default: float) -> float:
        try:
            return float(self.get(key, default))
        except (TypeError, ValueError):
            return default

    # ── addresses ────────────────────────────────────────────────────────

    @property
    def media_host(self) -> str:
        return self.get("IBVAP_MEDIA_HOST", "127.0.0.1")

    @property
    def rtsp_port(self) -> int:
        return self.int_("IBVAP_RTSP_PORT", 8554)

    def rtsp_url(self, camera_id: str) -> str:
        return f"rtsp://{self.media_host}:{self.rtsp_port}/{camera_id}"

    @property
    def backend_url(self) -> str:
        host = self.get("IBVAP_BACKEND_HOST", "127.0.0.1")
        port = self.int_("IBVAP_BACKEND_PORT", 8000)
        return f"http://{host}:{port}"

    @property
    def live_bind(self) -> str:
        return self.get("IBVAP_BOXES_BIND", "0.0.0.0")

    @property
    def live_port(self) -> int:
        return self.int_("IBVAP_BOXES_PORT", 8100)

    # ── cpu budget ───────────────────────────────────────────────────────

    @property
    def imgsz(self) -> int:
        return self.int_("IBVAP_IMGSZ", 480)

    @property
    def conf(self) -> float:
        return self.float_("IBVAP_CONF", 0.35)

    @property
    def weights(self) -> str:
        """
        Resolved against THIS directory, not the current one.

        `IBVAP_WEIGHTS` is a bare filename, and ultralytics resolves a bare
        name against the working directory — so `python ibvap/main.py` from the
        repo root looked for the weights in the root, while `python main.py`
        from inside `ibvap/` looked here. Both launches are documented, so the
        repo ended up carrying two byte-identical 5.6 MB copies, and deleting
        either one silently re-downloaded it on the next run from that
        direction. One copy, found from either launch.

        A path that does not exist is passed through untouched so ultralytics
        can still download it on a fresh machine.
        """
        configured = self.get("IBVAP_WEIGHTS", "yolo11n.pt")
        if Path(configured).is_absolute():
            return configured
        local = HERE / configured
        return str(local) if local.exists() else configured

    @property
    def face_model(self) -> str:
        """
        Resolved against THIS directory, not the current one -- the identical
        bug `weights` documents: a bare relative path resolves differently
        depending on whether `main.py` was launched from the repo root or
        from inside `ibvap/`, and a "missing" model on one launch and not the
        other looks like a broken model rather than a path bug.
        """
        configured = self.get("IBVAP_FACE_MODEL",
                              "data/face_detection_yunet_2023mar.onnx")
        if Path(configured).is_absolute():
            return configured
        local = HERE / configured
        return str(local) if local.exists() else configured

    @property
    def target_fps(self) -> float:
        """
        Processed frames per second, per camera. NOT the camera's frame rate.

        Capping here rather than running at stream rate is what keeps several
        cameras on one box sane. The overlay still reads as live at 5-10 fps
        because a person crossing a fence does not move far in 150 ms; the
        detector, which is the expensive part, does a fifth of the work.

        Held time is measured in seconds throughout, so lowering this does not
        silently change what a zone's confirm window means.
        """
        return self.float_("IBVAP_TARGET_FPS", 6.0)

    @property
    def zone_refresh_seconds(self) -> float:
        return self.float_("IBVAP_ZONE_REFRESH_SECONDS", 15.0)


@dataclass
class CameraConfig:
    id: str
    label: str
    rtsp_url: str
    #: Whether detections are training/test observations. The manifest can
    #: explicitly mark an approved replay feed operational; source transport
    #: alone must not silently discard its ANPR records.
    simulated: bool
    modules: dict[str, dict] = field(default_factory=dict)

    def module_params(self, name: str) -> dict:
        return self.modules.get(name) or {}


def _manifest() -> dict:
    return yaml.safe_load((MEDIA / "cameras.yml").read_text(encoding="utf-8")) or {}


def _modules_for(raw: Any) -> dict[str, dict]:
    """
    A camera's `modules:` block, in either of the two shapes people write.

        modules: [fence, anpr]              names only, default params
        modules:                            names with params
          fence: {confirm_frames: 4}
          anpr:  {report_interval: 12}
    """
    if raw is None:
        return dict(DEFAULT_MODULES)
    if isinstance(raw, list):
        return {name: {} for name in raw}
    if isinstance(raw, dict):
        return {name: dict(params or {}) for name, params in raw.items()}
    raise SystemExit(f"[config] `modules:` must be a list or a mapping, got {type(raw).__name__}")


def load_cameras(settings: Settings | None = None) -> list[CameraConfig]:
    """
    The cameras THIS machine runs detection on.

        IBVAP_WORKER_CAMERAS=all          every camera with detect: true
        IBVAP_WORKER_CAMERAS=cam_a,cam_b  exactly those, if they detect

    A camera with `detect: false` is never returned: it still has video in the
    hub and a live tile on the console, it just has no boxes. That is a real
    state the console shows honestly rather than a failure.
    """
    settings = settings or Settings()
    manifest = _manifest()
    defaults = manifest.get("defaults") or {}
    entries = manifest.get("cameras") or []

    known = {entry["id"] for entry in entries}
    wanted = settings.get("IBVAP_WORKER_CAMERAS", "all").strip()
    if wanted.lower() in ("all", "*", ""):
        names = None
    else:
        names = [n.strip() for n in wanted.split(",") if n.strip()]
        for name in names:
            if name not in known:
                raise SystemExit(
                    f"[config] IBVAP_WORKER_CAMERAS names `{name}`, which is not "
                    f"in media/cameras.yml. Known: {', '.join(sorted(known))}"
                )

    out: list[CameraConfig] = []
    for entry in entries:
        merged = dict(defaults)
        merged.update(entry)
        if not merged.get("detect"):
            continue
        if names is not None and merged["id"] not in names:
            continue
        kind = (merged.get("source") or {}).get("kind", "file")
        out.append(CameraConfig(
            id=merged["id"],
            label=merged.get("label", merged["id"]),
            rtsp_url=settings.rtsp_url(merged["id"]),
            simulated=bool(merged.get("simulated", kind == "file")),
            modules=_modules_for(merged.get("modules", defaults.get("modules"))),
        ))
    return out


# ── zones, from the node ─────────────────────────────────────────────────

def fetch_zones(settings: Settings, timeout=3.0) -> dict[str, list[dict]]:
    """
    Camera id -> the zone list its fence module should judge against.

    Raises on any failure. The caller decides what an unreachable node means;
    this function never invents a zone or returns a stale one, because a fence
    judging against geometry nobody drew is worse than a fence that says out
    loud it has none.

    The node may hand out a shape IT knows nobody drew — the placeholder a
    camera gets when it joins a zone — and labels it `provisional`. That is
    still the node's geometry, not a guess made here, so the promise above
    holds unchanged. This service's job is to carry the label through to the
    event as a fact; deciding what it MEANS is the node's, which is why nothing
    downstream of here acts on it.
    """
    request = urllib.request.Request(f"{settings.backend_url}/api/config",
                                     headers={"accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        config = json.loads(response.read().decode("utf-8"))

    out: dict[str, list[dict]] = {}
    for camera in config.get("cameras") or []:
        zones = []
        for zone in camera.get("zones") or []:
            if not zone.get("active", True):
                continue
            zones.append({
                "id": zone["id"],
                "name": zone.get("name", zone["id"]),
                "kind": zone.get("kind", "fence_line"),
                "geometry": zone.get("geometry", "line"),
                "points": zone.get("points") or [],
                "direction": zone.get("direction", "both"),
                "confirm_seconds": float(zone.get("confirmSeconds", 0) or 0),
                # Every class the zone NAMES, alerted or log-only alike. This
                # service decides whether a crossing happened; the node decides
                # how loudly to say so, because severity follows the zone's
                # operator-editable targets and must not be duplicated here.
                "classes": [t["class"] for t in (zone.get("targets") or [])],
                # True when nobody has drawn this shape against this camera's
                # view — it is the node's stock placeholder. Defaults FALSE
                # when the key is absent: a node too old to send it has the
                # unlabelled-placeholder behaviour anyway, and defaulting true
                # would mark every operator-drawn zone provisional, which is a
                # warning that fires on everything and so is read by nobody.
                "provisional": bool(zone.get("provisional", False)),
            })
        out[camera["id"]] = zones
    return out


# ── the last-good zone cache ─────────────────────────────────────────────
#
# A DELIBERATE REVERSAL of the rule stated at the top of this file, and it is
# written down here rather than left as a surprise in the diff.
#
# The old rule was absolute: never cache a shape from a previous run. The
# reason was sound — an operator's edit must not be outvoted by a stale copy,
# and an event judged against geometry that has since moved is a lie the audit
# log cannot correct. What the rule got wrong was the alternative. A detector
# that goes completely blind when the node restarts is not safer than one that
# keeps watching and says its geometry is unverified; it simply records nothing
# at all, which is the one outcome nobody can review afterwards.
#
# So the cache is allowed, and fenced in hard:
#
#   * used ONLY at startup, ONLY when the node is unreachable. A mid-run outage
#     changes nothing, because the modules already hold live zones, which are
#     by definition fresher than anything on disk.
#   * every zone it returns is marked `stale`, carried into the event, and the
#     node records those crossings WITHOUT alerting — the same treatment a
#     provisional shape gets, for the same reason: the geometry may have been
#     edited during the outage and nobody can know.
#   * keyed by backend URL, so pointing a worker at a different node cannot
#     resurrect the wrong post's zones.
#   * `fetch_zones` above is untouched and still raises. It still never invents
#     or returns a stale zone. Caching is the CALLER's decision, made once, at
#     startup, where it can be seen.
#
# Worth knowing before relying on it: if the node is down the events cannot be
# delivered either. DurableSink banks 512 and sheds the newest beyond that, so
# a long outage judges correctly and still loses the tail. The run summary says
# how many.

CACHE_PATH = HERE / ".zone-cache.json"


def cache_zones(settings: Settings, zones: dict[str, list[dict]]) -> None:
    """Remember the last good answer. Best effort — a failure here is not one
    worth taking the detector down for."""
    try:
        CACHE_PATH.write_text(json.dumps({
            "backend": settings.backend_url,
            "cached_at": time.time(),
            "zones": zones,
        }), encoding="utf-8")
    except OSError as error:
        print(f"[zones] could not write the zone cache: {error}")


def cached_zones(settings: Settings) -> tuple[dict[str, list[dict]], float] | None:
    """
    The last good answer, or None.

    Every zone comes back marked `stale` with the time it was written, so
    nothing downstream can mistake it for something an operator has confirmed.
    """
    try:
        stored = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None

    # A cache written against a different node describes a different post.
    if stored.get("backend") != settings.backend_url:
        return None

    cached_at = float(stored.get("cached_at") or 0.0)
    out: dict[str, list[dict]] = {}
    for camera_id, zones in (stored.get("zones") or {}).items():
        out[camera_id] = [dict(zone, stale=True, cached_at=cached_at) for zone in zones]
    return out, cached_at
