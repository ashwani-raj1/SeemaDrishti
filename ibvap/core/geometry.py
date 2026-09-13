"""
Zone geometry. Pure functions over normalised (0..1) frame coordinates.

No model, no clock, no state — so this is the part that can be reasoned about
exhaustively and trusted everywhere else.

WHY THIS FILE EXISTS AT ALL: fence evaluation moved from the edge node into
this service, so the geometry had to come with it. This is a deliberate port
of `backend/src/l2/geometry.ts` — same conventions, same epsilon, same
inbound/outbound definition. **If you change a rule here, change it there
too**, or a zone drawn by an operator will mean one thing to the console's
preview and another to the detector judging it.

The node keeps its copy because the simulator still posts raw detections
through `/hooks/ingress/detections` and is judged by the node's own fence.

STATUS: prototype.
"""

from typing import Literal, Optional, Sequence

Point = tuple[float, float]
Direction = Literal["inbound", "outbound"]

EPSILON = 1e-9


def ground_point(bbox_xywh: Sequence[float]) -> Point:
    """
    The point on a detection compared against a zone: bottom-centre of the box,
    i.e. where the subject touches the ground.

    Using the box centre would make a tall person cross a line roughly half a
    body-height early — the single most common way a fence demo looks broken.
    """
    x, y, w, h = bbox_xywh
    return (x + w / 2.0, y + h)


def _side_of(p1: Point, p2: Point, p: Point) -> float:
    """Which side of the directed segment p1->p2 the point falls on.

    Positive is the right-hand side looking along p1 -> p2.
    """
    return (p2[0] - p1[0]) * (p[1] - p1[1]) - (p2[1] - p1[1]) * (p[0] - p1[0])


def _sign(n: float, epsilon: float = EPSILON) -> int:
    if n > epsilon:
        return 1
    if n < -epsilon:
        return -1
    return 0


def segments_cross(a1: Point, a2: Point, b1: Point, b2: Point) -> bool:
    """Do segments a1-a2 and b1-b2 properly intersect?"""
    d1 = _sign(_side_of(b1, b2, a1))
    d2 = _sign(_side_of(b1, b2, a2))
    d3 = _sign(_side_of(a1, a2, b1))
    d4 = _sign(_side_of(a1, a2, b2))
    return d1 != d2 and d3 != d4


def point_in_polygon(polygon: Sequence[Point], p: Point) -> bool:
    """Ray casting. Points exactly on an edge count as inside."""
    inside = False
    count = len(polygon)
    j = count - 1
    for i in range(count):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        straddles = (yi > p[1]) != (yj > p[1])
        if straddles and p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def side_for_zone(geometry: str, points: Sequence[Point], p: Point) -> int:
    """
    Where a subject stands relative to a zone, reduced to one bit.

    Polygon: inside (1) or outside (-1).
    Line (or polyline): which side of it. A polyline uses its FIRST and LAST
    vertex to define overall direction, so "inbound" stays meaningful on a
    fence drawn with a kink in it.
    """
    if geometry == "polygon":
        return 1 if point_in_polygon(points, p) else -1
    return _sign(_side_of(points[0], points[-1], p))


def crossing_of(
    geometry: str, points: Sequence[Point], frm: Point, to: Point
) -> Optional[Direction]:
    """
    Did the move from `frm` to `to` cross this zone, and which way?

    Convention, worth stating out loud because operators draw these:
      - line zone: the subject crosses INBOUND when it moves onto the
        right-hand side of the line as drawn (first point -> last point). Draw
        the fence left-to-right with the friendly side below it, and inbound
        means "came towards us".
      - polygon zone: INBOUND is entering the shape, OUTBOUND is leaving it.

    Returns None when the subject did not cross.
    """
    if geometry == "polygon":
        was = point_in_polygon(points, frm)
        now = point_in_polygon(points, to)
        if was == now:
            return None
        return "inbound" if now else "outbound"

    touched = False
    for i in range(len(points) - 1):
        if segments_cross(frm, to, points[i], points[i + 1]):
            touched = True
            break
    if not touched:
        return None

    before = side_for_zone(geometry, points, frm)
    after = side_for_zone(geometry, points, to)
    if before == after:
        return None  # grazed a vertex without changing side
    return "inbound" if after == 1 else "outbound"


def direction_wanted(zone_direction: str, direction: Direction) -> bool:
    """Does this zone care about a crossing in this direction?"""
    return zone_direction == "both" or zone_direction == direction
