"""
The module interface. Everything that has an opinion about a frame is one.

A module receives the SHARED detection pass and returns two lists:

    live     things to draw right now, unconfirmed, droppable
    durable  things that happened and must be recorded

Returning them separately is the whole design: the dispatcher never has to
guess which channel an item belongs on, and a module can never accidentally
promote a flickering guess into the permanent record by putting it in the
wrong list.

ADDING A MODULE: write a class here in `modules/`, register it in REGISTRY,
and name it in a camera's `modules:` block. The dispatcher, the websocket
server and the HTTP sink do not change — that is the test of whether this
layer is actually pluggable, and it is why `process()` returns plain dicts
rather than anything the transport layer has to understand.

WHAT A MODULE MUST NOT DO: run its own object detector (the shared pass is the
point), reach the database, decide an event's severity, or know that an
operator exists. Severity is the node's call because a zone's targets are
operator-editable; this service reports what happened, not how loudly to shout.

STATUS: prototype.
"""

from dataclasses import dataclass
from typing import Any


@dataclass
class FrameContext:
    """
    What a module needs to know about the frame beyond its pixels.

    `ts` is MONOTONIC seconds, not wall clock. Debounce and cooldown measure
    held time by differencing these, and a post with no NTP will step its wall
    clock — a step makes a pending crossing either confirm instantly or never
    confirm at all. The wall-clock time for display and storage is stamped once,
    at the dispatcher, on its way out.
    """

    camera_id: str
    ts: float
    width: int
    height: int
    frame_index: int


class VisionModule:
    """Base class. Subclasses override `process`, and usually `configure`."""

    #: Wire name. Appears in every LiveObservation and DurableEvent it emits.
    name: str = "base"

    def __init__(self, camera_id: str, params: dict[str, Any] | None = None):
        self.camera_id = camera_id
        self.params: dict[str, Any] = {}
        self.configure(params or {})

    def configure(self, params: dict[str, Any]) -> None:
        """
        Apply (or re-apply) configuration.

        Called once at construction and again whenever the node's config is
        re-read — an operator editing a zone has to reach the detector judging
        it, and this is the only path by which it can. Implementations must be
        safe to call on a running module, and must not drop per-track state
        that is unrelated to what changed.
        """
        self.params = dict(params)

    def process(self, frame, detections: list[dict], ctx: FrameContext):
        """
        Returns (live, durable).

        `frame`      the BGR image, for modules that need pixels (ANPR crops).
        `detections` the shared pass output — see core/detection.py for shape.
        `ctx`        frame metadata; see FrameContext.
        """
        raise NotImplementedError

    def stats(self) -> dict:
        """Numbers for the run summary. Measured, never estimated."""
        return {}


#: Name -> class. `config.py` resolves a camera's `modules:` block through this.
REGISTRY: dict[str, type[VisionModule]] = {}


def register(cls: type[VisionModule]) -> type[VisionModule]:
    REGISTRY[cls.name] = cls
    return cls


def build(name: str, camera_id: str, params: dict[str, Any]) -> VisionModule:
    if name not in REGISTRY:
        known = ", ".join(sorted(REGISTRY)) or "none"
        raise SystemExit(
            f"[modules] camera {camera_id} asks for module `{name}`, which does "
            f"not exist. Known modules: {known}"
        )
    return REGISTRY[name](camera_id, params)
