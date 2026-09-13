"""
The two output contracts. Not one shape with two destinations — two shapes.

    LiveObservation  -> frontend over WebSocket   ephemeral, droppable
    DurableEvent     -> edge node over HTTP       confirmed, must not be lost

WHY THEY ARE NOT THE SAME OBJECT: if a "confirmed intrusion" went out over the
websocket *and* to the node in parallel, a slow console or a failed POST would
produce alerts visible live but absent from history, duplicates on reconnect,
operator decisions taken against events that were never persisted, and two
consoles disagreeing about what is happening. Splitting the contract in two
prevents all of it by construction: nothing durable is ever only in a browser.

    Detector output, a box on frame 120   vision service   ephemeral
    Current track trajectory              vision service   ephemeral
    Confirmed crossing / accepted plate   edge node        durable
    Operator acknowledge / dismiss        edge node        durable + audited

The frontend must treat the node's own rebroadcast — not a message from here —
as authoritative for anything durable, even when it saw the live version first.

COORDINATES: every box on both contracts is NORMALISED 0..1 against the frame.
The spec writes the live box as [x1, y1, x2, y2] and that is what ships; the
normalisation is this system's own rule and is not negotiable, because
detection runs on a 480p substream while the console displays 720p, and a zone
drawn on one must survive the other. The durable side additionally carries
[x, y, w, h] because that is the node's stored `Detection` shape.

STATUS: prototype.
"""

from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class LiveObservation:
    """
    One module's view of one frame, for the live overlay only.

    Never written to a database. Safe to drop entirely if the console is slow
    or gone — by the time a box is late it is already wrong, and a stale box is
    worse than no box.
    """

    camera_id: str
    module: str
    frame_ts: float
    tracks: list[dict] = field(default_factory=list)
    kind: str = "live"

    def to_dict(self) -> dict:
        return {
            "camera_id": self.camera_id,
            "module": self.module,
            "kind": self.kind,
            "frame_ts": round(self.frame_ts, 3),
            "tracks": self.tracks,
        }


def live_track(detection: dict, extra: Optional[dict] = None) -> dict:
    """
    One entry in a LiveObservation's `tracks`.

    `extra` is the module-specific transient slot: a live plate OCR guess, a
    trajectory tail, a zone-side flag. Anything a module wants drawn but has
    not confirmed belongs here — which is precisely why none of it is allowed
    to reach the durable path from this object.
    """
    return {
        "track_id": detection.get("track_id"),
        "bbox": [round(v, 5) for v in detection["bbox"]],
        "confidence": round(float(detection.get("confidence", 0.0)), 4),
        "class": detection.get("class", "object"),
        "extra": extra or {},
    }


@dataclass
class DurableEvent:
    """
    Something confirmed and worth keeping: an intrusion that survived debounce,
    an accepted plate read, a camera that went dark.

    The node validates, persists, groups into incidents and rebroadcasts. This
    service never decides an event's severity, never opens an incident, and
    never learns what an operator did about it.
    """

    camera_id: str
    module: str
    event_type: str
    timestamp: float
    track_id: Optional[int] = None
    data: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "camera_id": self.camera_id,
            "module": self.module,
            "event_type": self.event_type,
            "track_id": self.track_id,
            "data": self.data,
            "timestamp": round(self.timestamp, 3),
        }

    @property
    def dedupe_key(self) -> str:
        """Identity for retry logging. Not sent; the node dedupes on its own."""
        return f"{self.camera_id}:{self.module}:{self.event_type}:{self.track_id}"


def legacy_box_frame(camera_id: str, frame_ts: float, detections: list[dict]) -> dict:
    """
    The console's current overlay message, kept alive during the migration.

    `frontend/src/lib/boxes.ts` filters on `t === "boxes"` and reads
    `[x, y, w, h]`. The spec's LiveObservation is a different shape, so the
    dispatcher sends BOTH on the same socket: the console ignores what it does
    not recognise, and nothing on screen breaks while the frontend still speaks
    the old contract.

    DELETE THIS the moment boxes.ts reads LiveObservation. It is a migration
    shim, not a second contract — it carries the raw shared detection pass, not
    any module's opinion, so it can never become the thing a module publishes.
    """
    return {
        "t": "boxes",
        "camera_id": camera_id,
        "capture_mono": round(frame_ts, 3),
        "boxes": [
            {
                "track_ref": d["track_ref"],
                "class": d["class"],
                "confidence": round(float(d["confidence"]), 4),
                "bbox": [round(v, 5) for v in d["bbox_xywh"]],
                **({"vehicle_type": d["subtype"]} if d.get("is_vehicle") else {}),
                **({"plate": d["plate"]} if d.get("plate") else {}),
            }
            for d in detections
            if d.get("track_ref")
        ],
    }
