"""
The shared detection pass: one YOLO + ByteTrack call per frame, per camera.

THE WHOLE POINT OF THIS FILE: every module sees the output of *this* call.
No module re-runs object detection of its own. Three modules each running
their own detector on a CPU box is three times the only cost that actually
matters, for the same boxes three times over.

ONE TRACKER PER CAMERA, DELIBERATELY: ultralytics keeps ByteTrack state on the
model object, and `persist=True` means "this frame continues the previous
sequence". Sharing one tracker across cameras interleaves unrelated scenes into
one association problem and produces constant id switches. The cost is N models
resident, which is the real reason worker count is a per-machine setting.

CLASS VOCABULARY: the detector speaks COCO; the rest of the system speaks the
operator's vocabulary — person, vehicle, boat, cattle, dog — because that is
what a zone's targets are written in (`backend/src/db/seed.ts`) and what a
supervisor picks from on screen. The translation happens here, once, so no
module ever has to know that a bus is COCO id 5.

STATUS: prototype.
"""

import os
import time
from pathlib import Path

from ultralytics import YOLO

#: IBVAP's own tracker tuning (a longer track_buffer than ultralytics' bundled
#: default -- see bytetrack.yaml's own docstring for why). Resolved against
#: THIS directory, not the current one, for the identical reason
#: config.py Settings.weights is: a bare relative name resolves differently
#: depending on where the process was launched from. Falls back to
#: ultralytics' own bundled "bytetrack.yaml" if this repo-local one is ever
#: missing, rather than failing to start.
_LOCAL_TRACKER_CFG = str(Path(__file__).resolve().parent.parent / "bytetrack.yaml")
DEFAULT_TRACKER_CFG = _LOCAL_TRACKER_CFG if os.path.exists(_LOCAL_TRACKER_CFG) else "bytetrack.yaml"

# COCO id -> (operator class, subtype). The coarse class is what a zone target
# matches on; the subtype is detail carried alongside for ANPR and display.
#
# Animals are included on purpose and cost nothing extra — they ride the same
# single pass. Cattle, dogs and nilgai cross a border fence constantly, and a
# zone that cannot name them has no way to say "write it down, never alert".
COCO_CLASSES: dict[int, tuple[str, str]] = {
    0: ("person", "person"),
    2: ("vehicle", "car"),
    3: ("vehicle", "two_wheeler"),
    5: ("vehicle", "bus"),
    7: ("vehicle", "truck"),
    8: ("boat", "boat"),
    16: ("dog", "dog"),
    19: ("cattle", "cow"),
}

VEHICLE_SUBTYPES = {"car", "two_wheeler", "bus", "truck"}

#: Weight on the NEW box each frame; the rest comes from the smoothed box a
#: track already had. Lower = steadier but slower to follow real motion;
#: higher = truer to this frame's raw detection but noisier. 0.5 settles a
#: single bad frame's error to under 6% of it within four frames -- under a
#: second at this service's cadence -- while still being visibly smoother
#: than 1.0 (no smoothing) on the very next frame. Not measured against a
#: real clip (claude.md §7's rule on unmeasured numbers applies here too);
#: tune per-camera if a specific scene needs steadier or snappier boxes.
BOX_SMOOTHING_ALPHA = 0.5


class SharedDetector:
    """
    One camera's detector. Call `detect(frame)` once per processed frame and
    hand the result to every active module.
    """

    def __init__(self, weights="yolo11n.pt", imgsz=640, conf=0.35, iou=0.5,
                 tracker_cfg=None, device="cpu", run_id="r0",
                 classes=None, box_smoothing=BOX_SMOOTHING_ALPHA):
        # 640, not the pipeline's own 480: this default only reaches callers
        # that do not pass their own imgsz -- ai_service.py and
        # people_ai_service.py, both single-camera, on-demand scanners with
        # real CPU headroom, never main.py's multi-camera pipeline (it always
        # passes settings.imgsz from config.py, hardcoded to 480 there,
        # independently of this default). Measured on this machine (20 calls,
        # first 3 discarded as model-warmup noise -- a raw single-sample
        # comparison understated this badly on the first attempt): median
        # detector time 158ms -> 233ms, +34%, and 6 -> 9 people found in the
        # same frame of data/cam1.mp4. Worth it for a single on-demand
        # stream; not decided here for five cameras contending on one box.
        self.model = YOLO(weights)
        self.imgsz = imgsz
        self.conf = conf
        self.iou = iou
        self.tracker_cfg = tracker_cfg or DEFAULT_TRACKER_CFG
        self.device = device
        self.run_id = run_id
        self.classes = sorted(classes if classes is not None else COCO_CLASSES.keys())
        # 1.0 turns this off entirely -- every box is exactly what the
        # detector just returned, same as before this existed.
        self.box_smoothing = box_smoothing

        self.calls = 0
        self.seconds = 0.0
        # track_id -> smoothed (x1, y1, x2, y2) in source pixels, carried
        # across calls so each frame's EMA blends against the LAST SMOOTHED
        # box, not the last raw one -- otherwise a single noisy frame would
        # still show up at full strength one step later. Rebuilt fresh each
        # call from only the track_ids actually seen that frame (see the end
        # of detect()), so a track that goes quiet does not leak state
        # forever and a reused id after ByteTrack's own buffer expires never
        # inherits a stale position.
        self._smoothed: dict[int, tuple[float, float, float, float]] = {}

    @property
    def mean_ms(self) -> float:
        return (self.seconds / self.calls * 1000.0) if self.calls else 0.0

    def detect(self, frame) -> list[dict]:
        """
        Run detection + tracking on one frame.

        Returns a list of normalised detection dicts. Every geometric form the
        rest of the service needs is produced HERE, once:

            bbox_px    (x1, y1, x2, y2) in source pixels — for cropping (ANPR)
            bbox       [x1, y1, x2, y2] normalised 0..1  — the live WS contract
            bbox_xywh  [x, y, w, h]     normalised 0..1  — the durable contract
            ground     (x, y)           normalised 0..1  — the zone test point

        WHY ALL FOUR IN ONE PLACE: two functions producing "the box" is how a
        system ends up with two conventions, and a wrongly-converted box still
        looks like a box. The failure is silent. One producer, one convention.
        """
        started = time.monotonic()
        results = self.model.track(
            frame,
            persist=True,
            classes=self.classes,
            imgsz=self.imgsz,
            conf=self.conf,
            iou=self.iou,
            tracker=self.tracker_cfg,
            device=self.device,
            verbose=False,
        )
        self.seconds += time.monotonic() - started
        self.calls += 1

        if not results:
            return []
        boxes = results[0].boxes
        if boxes is None:
            return []

        height, width = frame.shape[:2]
        out: list[dict] = []
        smoothed_this_frame: dict[int, tuple[float, float, float, float]] = {}

        for b in boxes:
            x1, y1, x2, y2 = (float(v) for v in b.xyxy[0].tolist())
            coco_id = int(b.cls[0]) if b.cls is not None else -1
            klass, subtype = COCO_CLASSES.get(coco_id, ("object", "object"))
            track_id = int(b.id[0]) if b.id is not None else None

            # Damps the frame-to-frame coordinate noise a raw per-frame
            # detector call has even for a stationary subject -- visible as a
            # box that wiggles despite nothing actually moving. Only tracks
            # WITH an id are smoothed: an id-less detection has no history to
            # blend against, and inventing one would smear it toward whatever
            # unrelated box happened to occupy that memory slot last.
            if track_id is not None:
                previous = self._smoothed.get(track_id)
                if previous is not None:
                    a = self.box_smoothing
                    x1 = a * x1 + (1 - a) * previous[0]
                    y1 = a * y1 + (1 - a) * previous[1]
                    x2 = a * x2 + (1 - a) * previous[2]
                    y2 = a * y2 + (1 - a) * previous[3]
                smoothed_this_frame[track_id] = (x1, y1, x2, y2)

            nx1, ny1 = x1 / width, y1 / height
            nx2, ny2 = x2 / width, y2 / height
            nw, nh = nx2 - nx1, ny2 - ny1

            out.append({
                "track_id": track_id,
                # WHY run_id PREFIXES THE REF: ByteTrack reuses integer ids once
                # a track dies, and restarts from 1 when this process restarts.
                # The node keys its records on (camera_id, track_ref) with a
                # UNIQUE constraint, so a bare id lets a new subject inherit a
                # dead one's pending crossing. Scoping the ref to this run makes
                # that impossible by construction rather than by luck.
                "track_ref": f"{self.run_id}:{track_id}" if track_id is not None else None,
                "class": klass,
                "subtype": subtype,
                "confidence": float(b.conf[0]),
                "bbox_px": (int(x1), int(y1), int(x2), int(y2)),
                "bbox": [nx1, ny1, nx2, ny2],
                "bbox_xywh": [nx1, ny1, nw, nh],
                "ground": (nx1 + nw / 2.0, ny1 + nh),
                "is_vehicle": subtype in VEHICLE_SUBTYPES,
                "is_person": klass == "person",
            })

        # Replaces the whole dict rather than updating it, so a track_id NOT
        # seen this frame is simply gone -- see the field's own docstring on
        # why that matters.
        self._smoothed = smoothed_this_frame
        return out
