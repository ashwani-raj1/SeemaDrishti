"""
Appearance re-identification: the seam, and deliberately not the model.

WHAT RE-ID IS FOR: ByteTrack associates by position and motion only. It has no
appearance model at all, so a subject that walks behind a wall for four seconds
comes back as a NEW track id, and a subject that walks from one camera to the
next has no relationship to themselves. Matching an appearance embedding
against a gallery of recently-seen ones is what closes both gaps.

WHY THERE IS NO MODEL HERE YET — stated plainly rather than discovered later:
an embedding model runs once per person box per frame, on the same CPU already
running detection and OCR, on hardware whose floor is a two-core 15 W laptop.
That cost has not been measured on team hardware, and a feature that pushes the
pipeline below usable frame rate is a regression, not a feature. So the
interface ships, the call sites exist, and `NullReID` answers "I don't know" —
which is the honest answer today, and is one file away from being a real one.

WHEN A MODEL IS ADDED: write a provider with `.embed()`, register it, and name
it in config. Nothing in `multi_human.py`, the dispatcher, or the contracts
changes. What must NOT happen is quietly describing tracker ids as re-ID
because the interface exists — see the naming rule at the bottom of this file.

STATUS: prototype. Interface only.
"""

from typing import Optional, Protocol, Sequence


class ReIDProvider(Protocol):
    """Turns a cropped person box into a comparable vector, or admits it cannot."""

    name: str

    def embed(self, frame, bbox_px: Sequence[int]) -> Optional[list[float]]:
        ...


class NullReID:
    """
    The honest no-op. Returns None for every crop.

    This is not a stub that will silently start guessing: None means "no
    appearance evidence exists", and every caller treats it as such, so a
    system running with this provider can never claim a re-identification it
    did not make.
    """

    name = "none"

    def embed(self, frame, bbox_px: Sequence[int]) -> Optional[list[float]]:
        return None


#: Name -> factory. A real provider (OSNet, MobileNet embeddings, whatever is
#: measured to fit) registers itself here and becomes selectable from config.
PROVIDERS: dict[str, type] = {"none": NullReID}


def build_reid(name: str) -> ReIDProvider:
    if name not in PROVIDERS:
        known = ", ".join(sorted(PROVIDERS))
        raise SystemExit(f"[reid] unknown provider `{name}`. Known: {known}")
    return PROVIDERS[name]()


def cosine(a: Sequence[float], b: Sequence[float]) -> float:
    """Similarity of two embeddings. 1.0 identical, 0.0 unrelated."""
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    return dot / (na * nb) if na and nb else 0.0


class Gallery:
    """
    Recently-seen identities, for matching a reappearing track against.

    Deliberately bounded and time-limited: this is a short-term memory for
    "is that the same person who just left frame", not a database of people.
    Nothing here is persisted, nothing leaves the process, and an entry expires
    on its own. The system of record stores events, never identities.
    """

    def __init__(self, threshold=0.75, ttl_seconds=120.0, limit=256):
        self.threshold = threshold
        self.ttl = ttl_seconds
        self.limit = limit
        self._entries: dict[str, tuple[float, list[float]]] = {}

    def match(self, embedding: Sequence[float], now: float) -> Optional[tuple[str, float]]:
        self._expire(now)
        best, score = None, 0.0
        for key, (_, vector) in self._entries.items():
            similarity = cosine(embedding, vector)
            if similarity > score:
                best, score = key, similarity
        if best is not None and score >= self.threshold:
            return best, score
        return None

    def remember(self, key: str, embedding: Sequence[float], now: float) -> None:
        self._entries[key] = (now, list(embedding))
        if len(self._entries) > self.limit:
            oldest = min(self._entries, key=lambda k: self._entries[k][0])
            del self._entries[oldest]

    def _expire(self, now: float) -> None:
        for key in [k for k, (seen, _) in self._entries.items() if now - seen > self.ttl]:
            del self._entries[key]


# NAMING RULE, non-negotiable in this repo:
# a tracker id is not an identity. Until a provider here returns real vectors,
# nothing in this service, its logs, its docs or a slide may use the words
# "re-identification", "recognition" or "identity" for what ByteTrack produces.
# It produces a track with a beginning and an end. That is all it produces.
