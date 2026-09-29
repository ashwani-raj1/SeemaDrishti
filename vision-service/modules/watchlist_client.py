"""
The person watchlist's read side for the vision service.

Backend owns the watchlist now (backend/src/l3/person_watchlist.ts,
schema.sql's table comment explains why): this polls
GET /api/watchlist/people on a timer and holds the result in memory, the
same pattern config.py's fetch_zones/zone_refresh_seconds already uses for
zone geometry -- an operator's enrolment reaches a running camera worker
within one refresh interval, no restart, and an unreachable node for one
interval keeps the LAST good list rather than going blind to a real match.

MATCHING LIVES HERE, ONCE, not duplicated per caller: modules/face.py (the
live per-camera pipeline) and people_ai_service.py (the Upload/Live-webcam
ad-hoc endpoint) both import this module and compare against the exact same
cached entries with the exact same thresholds, instead of two
implementations that could quietly drift apart. Both also use it to WRITE
(enroll/remove) -- the backend is the single source of truth either way.
"""

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional, Sequence

#: opencv_zoo's own published same-identity threshold for this SFace model
#: (see modules/face.py's docstring for the offline verification behind it).
FACE_MATCH_THRESHOLD = 0.363

#: Matches people_ai_service.py's original constant -- HistogramReID's
#: colour signature is far weaker than a face embedding, so it needs a
#: correspondingly higher bar before it counts as a match at all.
APPEARANCE_MATCH_THRESHOLD = 0.75


def cosine(a: Sequence[float], b: Sequence[float]) -> float:
    import numpy as np
    va = np.asarray(a, dtype="float32")
    vb = np.asarray(b, dtype="float32")
    denom = float(np.linalg.norm(va) * np.linalg.norm(vb))
    if denom == 0.0:
        return 0.0
    return float(np.dot(va, vb) / denom)


class WatchlistClient:
    def __init__(self, backend_url: str, refresh_seconds: float = 5.0, timeout: float = 3.0):
        self.backend_url = backend_url.rstrip("/")
        self.refresh_seconds = refresh_seconds
        self.timeout = timeout
        self._entries: list[dict] = []
        self._last_refresh = 0.0
        self._warned = False

    def refresh(self, force: bool = False) -> None:
        now = time.monotonic()
        if not force and (now - self._last_refresh) < self.refresh_seconds:
            return
        self._last_refresh = now
        try:
            request = urllib.request.Request(
                f"{self.backend_url}/api/watchlist/people?active=true",
                headers={"accept": "application/json"},
            )
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                self._entries = json.loads(response.read().decode("utf-8"))
            self._warned = False
        except (urllib.error.URLError, OSError, ValueError) as error:
            if not self._warned:
                print(f"[watchlist] cannot reach {self.backend_url}/api/watchlist/people: {error} "
                      f"-- keeping the last {len(self._entries)} entr"
                      f"{'y' if len(self._entries) == 1 else 'ies'} known")
                self._warned = True

    def entries(self) -> list[dict]:
        self.refresh()
        return self._entries

    def match(self, face_embedding: Optional[list[float]],
              appearance_embedding: Optional[list[float]]) -> Optional[dict]:
        """
        Best match across the cached watchlist. Face wins over appearance
        whenever a face match clears its (much higher) bar, even if an
        appearance match also would have -- the same "prefer the stronger
        signal" rule people_ai_service.py's /detect always applied.
        """
        entries = self.entries()
        best = None
        if face_embedding is not None:
            for entry in entries:
                fe = entry.get("face_embedding")
                if not fe:
                    continue
                score = cosine(face_embedding, fe)
                if score >= FACE_MATCH_THRESHOLD and (best is None or score > best["score"]):
                    best = {"id": entry["id"], "name": entry["name"], "signal": "face", "score": score}
        if best is not None:
            return best
        if appearance_embedding is not None:
            for entry in entries:
                ae = entry.get("appearance_embedding")
                if not ae:
                    continue
                score = cosine(appearance_embedding, ae)
                if score >= APPEARANCE_MATCH_THRESHOLD and (best is None or score > best["score"]):
                    best = {"id": entry["id"], "name": entry["name"], "signal": "appearance", "score": score}
        return best

    def enroll(self, name: str, face_embedding: Optional[list[float]] = None,
               appearance_embedding: Optional[list[float]] = None,
               address: Optional[str] = None, owned_plates: Optional[list[str]] = None,
               govt_id: Optional[str] = None) -> dict:
        body = json.dumps({
            "name": name,
            "faceEmbedding": face_embedding,
            "appearanceEmbedding": appearance_embedding,
            "address": address,
            "ownedPlates": owned_plates,
            "govtId": govt_id,
        }).encode("utf-8")
        request = urllib.request.Request(
            f"{self.backend_url}/api/watchlist/people", data=body, method="POST",
            headers={"content-type": "application/json", "accept": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            entry = json.loads(response.read().decode("utf-8"))
        self.refresh(force=True)
        return entry

    def remove(self, name: str) -> None:
        request = urllib.request.Request(
            f"{self.backend_url}/api/watchlist/people/{urllib.parse.quote(name, safe='')}",
            method="DELETE",
        )
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            response.read()
        self.refresh(force=True)
