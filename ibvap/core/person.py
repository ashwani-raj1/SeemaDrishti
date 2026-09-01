"""
Person detection + identity tracking.

DESIGN DECISIONS YOU MUST BE ABLE TO DEFEND:

1. YOLO11n (nano). On CPU there is no headroom for s/m/l. Nano is the only
   size that leaves budget for the face stage on top.

2. classes=[0]. COCO class 0 is 'person'. We tell the model to score only
   that class. Cheaper NMS, no spurious vehicle/animal boxes.

3. ByteTrack, not DeepSORT. DeepSORT runs a separate appearance re-ID CNN on
   every box every frame -- a second network per person. On CPU that is fatal.
   ByteTrack associates using IoU + a Kalman motion model only, so its cost is
   effectively zero next to the detector.
   HONEST LIMITATION: without appearance features, a person fully occluded for
   longer than track_buffer frames returns with a NEW id. ByteTrack's
   second-pass association over low-confidence boxes recovers short occlusions,
   not long ones. Do not claim persistent re-identification. You do not have it.

4. persist=True is mandatory. It tells the tracker this frame continues the
   previous sequence. Omit it and track ids reset every call.

STATUS: prototype. Production would add ONNX/OpenVINO export (see benchmark.py)
and per-camera tracker instances.
"""

from ultralytics import YOLO

PERSON_CLASS_ID = 0


class PersonTracker:
    def __init__(self, weights="yolo11n.pt", imgsz=640, conf=0.35, iou=0.5,
                 tracker_cfg="bytetrack.yaml", device="cpu"):
        self.model = YOLO(weights)
        self.imgsz = imgsz
        self.conf = conf
        self.iou = iou
        self.tracker_cfg = tracker_cfg
        self.device = device

    def update(self, frame):
        """
        Run detection + tracking on one frame.
        Returns a list of dicts:
            {track_id, bbox (x1,y1,x2,y2 ints), conf}
        track_id is None for a detection the tracker has not yet confirmed.
        """
        results = self.model.track(
            frame,
            persist=True,
            classes=[PERSON_CLASS_ID],
            imgsz=self.imgsz,
            conf=self.conf,
            iou=self.iou,
            tracker=self.tracker_cfg,
            device=self.device,
            verbose=False,
        )

        out = []
        if not results:
            return out

        boxes = results[0].boxes
        if boxes is None or boxes.id is None:
            # Detections exist but no confirmed tracks yet (first frames).
            if boxes is not None:
                for b in boxes:
                    x1, y1, x2, y2 = b.xyxy[0].tolist()
                    out.append({
                        "track_id": None,
                        "bbox": (int(x1), int(y1), int(x2), int(y2)),
                        "conf": float(b.conf[0]),
                    })
            return out

        for b in boxes:
            x1, y1, x2, y2 = b.xyxy[0].tolist()
            out.append({
                "track_id": int(b.id[0]),
                "bbox": (int(x1), int(y1), int(x2), int(y2)),
                "conf": float(b.conf[0]),
            })
        return out


class TrackHistory:
    """
    Keeps a trail of centre points per track id -> this is your 'movement
    tracking' deliverable. Also the raw material for later features
    (loitering = long dwell, direction violation = trail vector).
    """

    def __init__(self, max_len=None):
        """
        max_len=None -> unlimited: trail holds every point for the life of the
        track. Fine for a bounded demo clip. A long-running live/RTSP source
        should pass a finite max_len to cap memory growth.
        """
        self.max_len = max_len
        self.trails = {}       # track_id -> list[(cx, cy)]
        self.first_seen = {}   # track_id -> frame_index
        self.last_seen = {}

    def update(self, detections, frame_index):
        for d in detections:
            tid = d["track_id"]
            if tid is None:
                continue
            x1, y1, x2, y2 = d["bbox"]
            cx, cy = (x1 + x2) // 2, y2  # feet point, not box centre
            trail = self.trails.setdefault(tid, [])
            trail.append((cx, cy))
            if self.max_len and len(trail) > self.max_len:
                trail.pop(0)
            self.first_seen.setdefault(tid, frame_index)
            self.last_seen[tid] = frame_index

    def dwell_frames(self, track_id):
        if track_id not in self.first_seen:
            return 0
        return self.last_seen[track_id] - self.first_seen[track_id]
