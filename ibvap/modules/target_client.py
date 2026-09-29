"""
The one-off target search's read side for the live camera pipeline.

Mirrors modules/watchlist_client.py's polling pattern (GET on a timer, keep
the last good value on a transient failure) against a much smaller backend
surface -- see backend/src/l3/target.ts's own docstring for why a target is
an in-memory singleton, not a database table: it is one operator's one-off
"who does this look like", never named, never meant to outlive their
session.

APPEARANCE ONLY: target search has never used a face embedding (see
people_ai_service.py's own docstring -- "colour-based re-association, not
recognition"). This client has no face-matching path at all, on purpose,
so a camera worker can never quietly grow one by accident.
"""

import json
import time
import urllib.error
import urllib.request
from typing import Optional

from modules.watchlist_client import cosine

#: Matches people.tsx's own TARGET_MATCH_THRESHOLD -- the two must agree, or
#: a track reads as "found" in one view and "not confirmed" in another for
#: the exact same footage.
TARGET_MATCH_THRESHOLD = 0.75


class TargetClient:
    def __init__(self, backend_url: str, refresh_seconds: float = 3.0, timeout: float = 3.0):
        self.backend_url = backend_url.rstrip("/")
        self.refresh_seconds = refresh_seconds
        self.timeout = timeout
        self._embedding: Optional[list[float]] = None
        self._last_refresh = 0.0
        self._warned = False

    def refresh(self, force: bool = False) -> None:
        now = time.monotonic()
        if not force and (now - self._last_refresh) < self.refresh_seconds:
            return
        self._last_refresh = now
        try:
            request = urllib.request.Request(
                f"{self.backend_url}/api/target", headers={"accept": "application/json"},
            )
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = json.loads(response.read().decode("utf-8"))
            self._embedding = body["appearanceEmbedding"] if body else None
            self._warned = False
        except (urllib.error.URLError, OSError, ValueError, KeyError) as error:
            if not self._warned:
                print(f"[target] cannot reach {self.backend_url}/api/target: {error} "
                      f"-- keeping the last target known")
                self._warned = True

    def score(self, appearance_embedding: Optional[list[float]]) -> Optional[float]:
        """
        Raw cosine similarity against the current target, or None if either
        side has nothing to compare -- never gated on TARGET_MATCH_THRESHOLD
        here. The threshold decides what counts as "found"; this function
        only answers "how close", the same split people_ai_service.py's own
        /detect already draws between computing a score and confirming one.
        """
        self.refresh()
        if self._embedding is None or appearance_embedding is None:
            return None
        return cosine(appearance_embedding, self._embedding)
