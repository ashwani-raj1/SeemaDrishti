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


class HistogramReID:
    """
    Colour-histogram appearance signature. The honest CPU-only middle ground
    between NullReID's "I don't know" and a learned embedding model whose cost
    has not been measured on team hardware (claude.md §7 -- that objection is
    about a deep model; a histogram is a resize and one cv2.calcHist call, not
    a network, so it does not carry the same unmeasured-cost problem).

    WHAT IT IS: an HSV colour histogram of the person crop, compared by cosine
    similarity. It captures "roughly the same clothing colours", nothing more.

    WHAT IT IS NOT, stated as plainly as reid.py's naming rule demands: a face
    or body embedding, and not recognition. Two people in similar-coloured
    clothing will read as the same identity to this provider, and the SAME
    person under very different lighting (walking from sun into shade) can
    read as a different one. It is real appearance evidence -- enough to
    bridge an occlusion ByteTrack's own motion association could not -- and it
    should be described as exactly that, never as anything stronger.
    """

    name = "histogram"

    def embed(self, frame, bbox_px: Sequence[int]) -> Optional[list[float]]:
        import cv2  # imported here, not at module scope -- a camera running
                    # NullReID should not pay for OpenCV's histogram path.

        x1, y1, x2, y2 = bbox_px
        crop = frame[max(0, y1):y2, max(0, x1):x2]
        if crop.size == 0:
            return None
        hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
        # Hue + saturation only, not value: value carries lighting/exposure,
        # which changes frame to frame and has nothing to do with identity.
        hist = cv2.calcHist([hsv], [0, 1], None, [30, 32], [0, 180, 0, 256])
        cv2.normalize(hist, hist)
        return hist.flatten().tolist()


#: Name -> factory. A real provider (OSNet, MobileNet embeddings, whatever is
#: measured to fit) registers itself here and becomes selectable from config.
PROVIDERS: dict[str, type] = {"none": NullReID, "histogram": HistogramReID}


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


SAMPLES_PER_IDENTITY = 5


class Gallery:
    """
    Recently-seen identities, for matching a reappearing track against.

    Deliberately bounded and time-limited: this is a short-term memory for
    "is that the same person who just left frame", not a database of people.
    Nothing here is persisted, nothing leaves the process, and an entry expires
    on its own. The system of record stores events, never identities.

    EACH IDENTITY KEEPS UP TO `SAMPLES_PER_IDENTITY` RECENT EMBEDDINGS, NOT
    ONE: a single stored vector makes a match live or die on whatever one
    frame happened to produce it, and a partial occlusion, motion blur or a
    crop caught mid-stride corrupts that one frame's colour histogram same as
    it would any other. Matching against the BEST of several recent samples
    is what a light pole passing in front of someone for a few frames needs --
    one bad sample no longer sinks the whole match, because the other four are
    still there to compare against.
    """

    def __init__(self, threshold=0.75, ttl_seconds=120.0, limit=256):
        self.threshold = threshold
        self.ttl = ttl_seconds
        self.limit = limit
        # key -> (last_seen, [recent embeddings, oldest first])
        self._entries: dict[str, tuple[float, list[list[float]]]] = {}

    def match(self, embedding: Sequence[float], now: float,
             exclude: "set[str] | None" = None) -> Optional[tuple[str, float]]:
        """
        `exclude` is every identity already resolved to a DIFFERENT track
        this same frame. Two people on screen at once can never be the same
        identity, no matter how similar their appearance signature -- without
        this, one frame with two similarly-dressed people can fold both onto
        the same "P<n>", which is a worse failure than missing a real match.
        """
        self._expire(now)
        best, score = None, 0.0
        for key, (_, vectors) in self._entries.items():
            if exclude and key in exclude:
                continue
            similarity = max(cosine(embedding, v) for v in vectors)
            if similarity > score:
                best, score = key, similarity
        if best is not None and score >= self.threshold:
            return best, score
        return None

    def candidates(self, embedding: Sequence[float], now: float,
                   exclude: "set[str] | None" = None) -> list[tuple[str, float]]:
        """
        Every identity clearing `threshold`, best first -- not just the single
        best one `match()` returns. A caller that has its OWN reason to reject
        the top match (e.g. `multi_human`'s motion-plausibility check: the
        closest-looking identity was on the other side of the frame a moment
        ago, so it cannot be this detection no matter how well the colours
        line up) needs the next-best candidate to fall back to, not nothing.
        """
        self._expire(now)
        scored = []
        for key, (_, vectors) in self._entries.items():
            if exclude and key in exclude:
                continue
            similarity = max(cosine(embedding, v) for v in vectors)
            if similarity >= self.threshold:
                scored.append((key, similarity))
        scored.sort(key=lambda kv: kv[1], reverse=True)
        return scored

    def best_score(self, embedding: Sequence[float], now: float,
                   exclude: "set[str] | None" = None) -> float:
        """
        The closest similarity in the gallery right now, regardless of
        threshold -- for calibrating `threshold` against a real clip instead
        of guessing it (claude.md §7). Not used by `match()` itself.
        """
        self._expire(now)
        return max((cosine(embedding, v)
                    for key, (_, vectors) in self._entries.items()
                    if not (exclude and key in exclude)
                    for v in vectors), default=0.0)

    def score_against(self, key: str, embedding: Sequence[float], now: float) -> float:
        """
        Similarity between `embedding` and ONE identity's recent samples
        specifically -- unlike `match()`/`best_score()`, which search every
        identity. For re-checking whether a track's current appearance still
        supports the identity it already has, not for finding a new one.
        """
        self._expire(now)
        entry = self._entries.get(key)
        if entry is None:
            return 0.0
        _, vectors = entry
        return max((cosine(embedding, v) for v in vectors), default=0.0)

    def remember(self, key: str, embedding: Sequence[float], now: float) -> None:
        _, vectors = self._entries.get(key, (now, []))
        vectors = vectors + [list(embedding)]
        if len(vectors) > SAMPLES_PER_IDENTITY:
            vectors = vectors[-SAMPLES_PER_IDENTITY:]
        self._entries[key] = (now, vectors)
        if len(self._entries) > self.limit:
            oldest = min(self._entries, key=lambda k: self._entries[k][0])
            del self._entries[oldest]

    def _expire(self, now: float) -> None:
        for key in [k for k, (seen, _) in self._entries.items() if now - seen > self.ttl]:
            del self._entries[key]


# NAMING RULE, non-negotiable in this repo:
# a ByteTrack id (`track_id`/`track_ref`) is not an identity, with NullReID or
# with any provider -- it is a track with a beginning and an end, nothing
# more. A `multi_human` PERSON id (the module's "P1", "P2", ... -- see its
# `_identities`) is different: it names one appearance-matched sequence of
# tracks, and with HistogramReID that match is real, measurable evidence, not
# a guess dressed up as one. It is still not "recognition" and still not a
# name -- it means "resembled an earlier crop by colour", and the module's own
# docs must say so every time the word "identity" appears near it. Upgrading
# to a stronger provider changes how GOOD the match is, never what the word
# is allowed to claim.
