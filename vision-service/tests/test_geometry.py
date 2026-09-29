"""
core/geometry.py — pure arithmetic over normalised frame coordinates.

No model, no camera, no network, no weights. A test that downloads a
checkpoint is a test that fails on a demo laptop the night before submission,
so nothing here imports ultralytics or touches a socket.

This file is a deliberate port of backend/src/l2/geometry.ts. If a rule changes
here it must change there in the same commit, or a zone drawn by an operator
means one thing to the console's preview and another to the detector judging
it — so several of these cases exist to pin the CONVENTION, not just the code.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

from core import geometry  # noqa: E402

# A horizontal line across the middle, drawn left to right. Everything below it
# (larger y) is the right-hand side looking along p0 -> pN, which the convention
# calls +1 / "inbound".
LINE = [(0.05, 0.50), (0.95, 0.50)]
BOX = [(0.30, 0.30), (0.70, 0.30), (0.70, 0.80), (0.30, 0.80)]


class TestGroundPoint:
    def test_is_bottom_centre_not_centre(self):
        # Using the box centre would make a tall person cross a line roughly
        # half a body-height early — the commonest way a fence demo looks broken.
        x, y = geometry.ground_point([0.40, 0.20, 0.20, 0.40])
        assert x == pytest.approx(0.50)
        assert y == pytest.approx(0.60)


class TestSideForZone:
    def test_below_the_line_is_the_inbound_side(self):
        assert geometry.side_for_zone("line", LINE, (0.5, 0.9)) == 1

    def test_above_the_line_is_outbound(self):
        assert geometry.side_for_zone("line", LINE, (0.5, 0.1)) == -1

    def test_exactly_on_the_line_is_neither(self):
        # The tri-state is the whole point: 0 means "no side established yet",
        # and both this module and modules/fence.py must treat it as such.
        assert geometry.side_for_zone("line", LINE, (0.5, 0.5)) == 0

    def test_a_polygon_is_only_ever_inside_or_outside(self):
        assert geometry.side_for_zone("polygon", BOX, (0.5, 0.5)) == 1
        assert geometry.side_for_zone("polygon", BOX, (0.1, 0.1)) == -1

    def test_a_polyline_uses_its_first_and_last_vertex(self):
        # So "inbound" stays meaningful on a fence drawn with a kink in it.
        kinked = [(0.05, 0.50), (0.50, 0.20), (0.95, 0.50)]
        assert geometry.side_for_zone("line", kinked, (0.5, 0.9)) == 1
        assert geometry.side_for_zone("line", kinked, (0.5, 0.1)) == -1


class TestPointInPolygon:
    def test_inside(self):
        assert geometry.point_in_polygon(BOX, (0.5, 0.5)) is True

    def test_outside(self):
        assert geometry.point_in_polygon(BOX, (0.9, 0.9)) is False

    def test_a_vertex_does_not_double_count(self):
        # Ray casting through a vertex is the classic way to get this wrong and
        # report a point outside the shape as inside.
        assert geometry.point_in_polygon(BOX, (0.9, 0.30)) is False


class TestCrossingOf:
    def test_downward_through_the_line_is_inbound(self):
        assert geometry.crossing_of("line", LINE, (0.5, 0.40), (0.5, 0.60)) == "inbound"

    def test_upward_through_the_line_is_outbound(self):
        assert geometry.crossing_of("line", LINE, (0.5, 0.60), (0.5, 0.40)) == "outbound"

    def test_drawing_the_line_the_other_way_flips_the_convention(self):
        # Operators draw these, so the direction of the drawing IS the meaning.
        reversed_line = list(reversed(LINE))
        assert geometry.crossing_of("line", reversed_line, (0.5, 0.40), (0.5, 0.60)) == "outbound"

    def test_no_crossing_returns_none(self):
        assert geometry.crossing_of("line", LINE, (0.5, 0.10), (0.5, 0.20)) is None

    def test_entering_a_polygon_is_inbound_and_leaving_is_outbound(self):
        assert geometry.crossing_of("polygon", BOX, (0.1, 0.5), (0.5, 0.5)) == "inbound"
        assert geometry.crossing_of("polygon", BOX, (0.5, 0.5), (0.1, 0.5)) == "outbound"

    def test_landing_exactly_on_the_line_is_not_yet_a_crossing(self):
        # THE REGRESSION. This used to return "outbound" — the opposite of the
        # travel direction — because the final line read
        # `"inbound" if after == 1 else "outbound"` and never considered that
        # `after` could be 0. It then poisoned the pending crossing in
        # modules/fence.py, which rejected the genuine crossing on the next
        # frame as flicker, and the subject walked through unrecorded.
        assert geometry.crossing_of("line", LINE, (0.5, 0.45), (0.5, 0.50)) is None

    def test_and_the_crossing_still_fires_from_the_line_on_the_next_step(self):
        # Nothing is lost by waiting one frame: the step OFF the line reports
        # the crossing, with the right direction.
        assert geometry.crossing_of("line", LINE, (0.5, 0.50), (0.5, 0.55)) == "inbound"
        assert geometry.crossing_of("line", LINE, (0.5, 0.50), (0.5, 0.45)) == "outbound"


class TestDirectionWanted:
    def test_both_accepts_either(self):
        assert geometry.direction_wanted("both", "inbound")
        assert geometry.direction_wanted("both", "outbound")

    def test_a_named_direction_rejects_the_other(self):
        assert geometry.direction_wanted("inbound", "inbound")
        assert not geometry.direction_wanted("inbound", "outbound")
