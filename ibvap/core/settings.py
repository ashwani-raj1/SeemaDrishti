"""
Where the other modules are, and what this machine is responsible for.

Every address the vision service needs comes from `.env` at the repo root, so
moving the media hub or the backend to another box is editing one line rather
than hunting hardcoded loopback addresses through the code. The camera list
comes from media/cameras.yml, which is shared and committed — the two files
answer different questions and are deliberately not merged:

    media/cameras.yml   WHAT cameras exist      shared, committed
    .env                WHERE modules run,      per-machine, ignored
                        and what THIS box does

That split is what makes one-worker-per-laptop possible. Every machine reads
the same manifest and a different IBVAP_WORKER_CAMERAS.

STATUS: prototype.
"""

import os
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent.parent
MEDIA = ROOT / "media"


def load_env(path=None):
    """
    Minimal .env reader — deliberately not python-dotenv.

    claude.md §9: no new dependency without justification, because each one is
    a laptop that fails to set up the night before submission. This is fifteen
    lines and has no failure mode worth a package.

    Real environment variables win over the file, so a one-off override on the
    command line still works.
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


class Settings:
    def __init__(self, env=None):
        self._env = env if env is not None else load_env()

    def get(self, key, default=""):
        got = self._env.get(key, "")
        return got if got != "" else default

    def int_(self, key, default):
        try:
            return int(self.get(key, default))
        except (TypeError, ValueError):
            return default

    def float_(self, key, default):
        try:
            return float(self.get(key, default))
        except (TypeError, ValueError):
            return default

    # ── addresses ────────────────────────────────────────────────────────

    @property
    def media_host(self):
        return self.get("IBVAP_MEDIA_HOST", "127.0.0.1")

    @property
    def rtsp_port(self):
        return self.int_("IBVAP_RTSP_PORT", 8554)

    def rtsp_url(self, camera_id):
        return f"rtsp://{self.media_host}:{self.rtsp_port}/{camera_id}"

    @property
    def backend_url(self):
        host = self.get("IBVAP_BACKEND_HOST", "127.0.0.1")
        port = self.int_("IBVAP_BACKEND_PORT", 8000)
        return f"http://{host}:{port}"

    @property
    def boxes_bind(self):
        return self.get("IBVAP_BOXES_BIND", "0.0.0.0")

    @property
    def boxes_port(self):
        return self.int_("IBVAP_BOXES_PORT", 8100)

    # ── cpu budget ───────────────────────────────────────────────────────

    @property
    def imgsz(self):
        return self.int_("IBVAP_IMGSZ", 480)

    @property
    def detect_every(self):
        return max(1, self.int_("IBVAP_DETECT_EVERY", 2))

    @property
    def conf(self):
        return self.float_("IBVAP_CONF", 0.35)

    @property
    def weights(self):
        return self.get("IBVAP_WEIGHTS", "yolo11n.pt")


def load_cameras():
    """Every camera in the manifest, with `defaults` merged into each."""
    manifest = yaml.safe_load((MEDIA / "cameras.yml").read_text(encoding="utf-8"))
    defaults = manifest.get("defaults") or {}
    out = []
    for cam in manifest.get("cameras") or []:
        merged = dict(defaults)
        merged.update(cam)
        out.append(merged)
    return out


def cameras_for_this_machine(settings=None):
    """
    The subset this box runs detection on.

    IBVAP_WORKER_CAMERAS=all              every camera with detect: true
    IBVAP_WORKER_CAMERAS=cam_a,cam_b      exactly those, if they detect

    A camera with `detect: false` is never returned: it still has video in the
    hub and a live tile in the console, it just has no boxes. That is a real
    state the console shows honestly rather than a failure.
    """
    settings = settings or Settings()
    wanted = settings.get("IBVAP_WORKER_CAMERAS", "all").strip()
    cameras = [c for c in load_cameras() if c.get("detect")]

    if wanted.lower() in ("all", "*", ""):
        return cameras

    names = [n.strip() for n in wanted.split(",") if n.strip()]
    known = {c["id"] for c in load_cameras()}
    for name in names:
        if name not in known:
            raise SystemExit(
                f"[settings] IBVAP_WORKER_CAMERAS names `{name}`, which is not "
                f"in media/cameras.yml. Known: {', '.join(sorted(known))}"
            )
    return [c for c in cameras if c["id"] in names]
