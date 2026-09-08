"""
Vehicle detection + tracking for perimeter checkpoints.

DESIGN DECISIONS:
1. YOLO11n (nano) with COCO vehicle classes:
   2: car, 3: motorcycle, 5: bus, 7: truck
2. ByteTrack tracker association for real-time edge performance without heavy GPU.
3. Outputs vehicle bbox + class + track_id for downstream cascaded ALPR / plate detection.
"""

from ultralytics import YOLO

# COCO class IDs for vehicles
VEHICLE_CLASS_MAP = {
    2: "car",
    3: "two_wheeler",
    5: "bus",
    7: "truck",
}


class VehicleTracker:
    def __init__(self, weights="yolo11n.pt", imgsz=640, conf=0.35, iou=0.5,
                 tracker_cfg="bytetrack.yaml", device="cpu"):
        self.model = YOLO(weights)
        self.imgsz = imgsz
        self.conf = conf
        self.iou = iou
        self.tracker_cfg = tracker_cfg
        self.device = device
        self.classes = list(VEHICLE_CLASS_MAP.keys())

    def update(self, frame):
        """
        Run vehicle detection + tracking on one frame.
        Returns list of dicts:
            {track_id, bbox (x1, y1, x2, y2), conf, class}
        """
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

        out = []
        if not results:
            return out

        boxes = results[0].boxes
        if boxes is None:
            return out

        for b in boxes:
            x1, y1, x2, y2 = b.xyxy[0].tolist()
            cls_id = int(b.cls[0]) if b.cls is not None else 2
            cls_name = VEHICLE_CLASS_MAP.get(cls_id, "vehicle")
            track_id = int(b.id[0]) if b.id is not None else None

            out.append({
                "track_id": track_id,
                "bbox": (int(x1), int(y1), int(x2), int(y2)),
                "conf": float(b.conf[0]),
                "class": cls_name,
            })
        return out
