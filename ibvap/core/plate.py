"""
Cascaded license plate detection (ALPR) and watchlist matching.

THE CORE IDEA:
Instead of running heavy full-frame OCR, run plate localization only inside
the lower-center portion of detected vehicle bounding boxes.

1. Crop lower-center region of vehicle bbox.
2. Preprocess: grayscale, adaptive thresholding, bilateral filtering to enhance plate characters.
3. Match against active edge watchlist.
"""

import re
import time
import cv2
import numpy as np
import easyocr


class PlateDetector:
    def __init__(self, watchlist=None, ocr_confidence=0.45):
        """
        watchlist: optional list of flagged plate strings, e.g. ["PB 02 AK 4821", "PB 02 T 9182"]
        """
        self.watchlist = [self.normalize(p) for p in (watchlist or [])]
        self.ocr_confidence = ocr_confidence
        self.reader = easyocr.Reader(["en"], gpu=False)
        # OCR is much more expensive than YOLO. Keep the last successful read
        # for a tracked vehicle briefly, but draw it in the vehicle's current
        # plate region so the overlay remains aligned as it moves.
        self._recent_reads = {}
        self._read_interval_seconds = 1.5

    @staticmethod
    def normalize(raw_plate):
        if not raw_plate:
            return ""
        return re.sub(r"[^A-Z0-9]", "", str(raw_plate).upper()).strip()

    @staticmethod
    def plate_region(vehicle_bbox, frame_shape, lower_frac=0.45, center_w_frac=0.60):
        """
        Extract the lower central region of the vehicle where license plates typically sit.
        """
        x1, y1, x2, y2 = vehicle_bbox
        w = x2 - x1
        h = y2 - y1

        # Lower portion
        py1 = y1 + int(h * (1.0 - lower_frac))
        py2 = y2

        # Center slice
        margin_w = int(w * (1.0 - center_w_frac) / 2)
        px1 = x1 + margin_w
        px2 = x2 - margin_w

        H, W = frame_shape[:2]
        return max(0, px1), max(0, py1), min(W, px2), min(H, py2)

    def preprocess_plate_crop(self, crop):
        """
        Enhance plate contrast and edge definition for OCR reading.
        """
        if crop is None or crop.size == 0:
            return None
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if len(crop.shape) == 3 else crop
        blurred = cv2.bilateralFilter(gray, 9, 75, 75)
        thresh = cv2.adaptiveThreshold(
            blurred, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY, 11, 2
        )
        return thresh

    def check_watchlist(self, plate_number):
        """
        Check if a read plate matches any entry in the watchlist.
        """
        norm = self.normalize(plate_number)
        for target in self.watchlist:
            if norm == target or (len(norm) >= 6 and (norm in target or target in norm)):
                return True, target
        return False, None

    def detect_for_vehicles(self, frame, vehicles):
        """
        vehicles: output from VehicleTracker.update()
        Returns list of dicts:
            {track_id, vehicle_class, plate_bbox, plate_crop, is_matched}
        """
        out = []
        H, W = frame.shape[:2]

        for v in vehicles:
            v_bbox = v["bbox"]
            px1, py1, px2, py2 = self.plate_region(v_bbox, (H, W))
            if (px2 - px1) < 20 or (py2 - py1) < 10:
                continue

            crop = frame[py1:py2, px1:px2]
            out.append({
                "track_id": v.get("track_id"),
                "vehicle_class": v.get("class", "vehicle"),
                "vehicle_bbox": v_bbox,
                "plate_bbox": (px1, py1, px2, py2),
                "plate_crop": crop,
            })
        return out

    def read_for_vehicle(self, frame, vehicle):
        """Return a conservative OCR reading, or None when a plate is unclear."""
        px1, py1, px2, py2 = self.plate_region(vehicle["bbox"], frame.shape)
        if px2 - px1 < 20 or py2 - py1 < 10:
            return None
        track_id = vehicle.get("track_id")
        now = time.monotonic()
        cached = self._recent_reads.get(track_id) if track_id is not None else None
        if cached and now - cached[0] < self._read_interval_seconds:
            text, confidence = cached[1], cached[2]
            return {"text": text, "confidence": confidence,
                    "bbox": (px1, py1, px2, py2)}
        crop = frame[py1:py2, px1:px2]
        crop = cv2.resize(crop, None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
        readings = self.reader.readtext(gray, detail=1, allowlist="ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
        if not readings:
            return None
        readings.sort(key=lambda item: min(point[0] for point in item[0]))
        text = self.normalize("".join(item[1] for item in readings))
        confidence = sum(float(item[2]) for item in readings) / len(readings)
        # Do not create a plate from noise: accept only a plausible mixed
        # alphanumeric registration with enough OCR confidence.
        if not (6 <= len(text) <= 12 and confidence >= self.ocr_confidence
                and any(c.isalpha() for c in text) and any(c.isdigit() for c in text)):
            return None
        points = [point for reading in readings for point in reading[0]]
        # OCR is executed on a 4x crop; return a tight source-frame box so
        # downstream UI saves the registration plate, not the car body.
        rx1 = max(px1, px1 + int(min(point[0] for point in points) / 4) - 8)
        ry1 = max(py1, py1 + int(min(point[1] for point in points) / 4) - 5)
        rx2 = min(px2, px1 + int(max(point[0] for point in points) / 4) + 8)
        ry2 = min(py2, py1 + int(max(point[1] for point in points) / 4) + 5)
        if track_id is not None:
            self._recent_reads[track_id] = (now, text, confidence)
            # Bound memory when a busy camera sees many unique tracks.
            if len(self._recent_reads) > 512:
                oldest = min(self._recent_reads, key=lambda key: self._recent_reads[key][0])
                del self._recent_reads[oldest]
        return {"text": text, "confidence": confidence, "bbox": (rx1, ry1, rx2, ry2)}
