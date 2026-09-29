"""
Cropping arithmetic for event thumbnails.

Only `crop_box` is tested, and deliberately: it is the half that can be wrong
without anything looking wrong. A crop that is off by a margin still produces a
perfectly valid JPEG of the wrong piece of ground, and nobody reviewing an
incident at 3 a.m. can tell. The encoding half is OpenCV's problem and needs a
real image to exercise, which is exactly the kind of test that fails on a demo
laptop.
"""

import pytest

from core.thumbnail import ASPECT, crop_box


def inside(box, w, h):
    x1, y1, x2, y2 = box
    return 0 <= x1 < x2 <= w and 0 <= y1 < y2 <= h


class TestCropBox:
    def test_the_crop_stays_inside_the_frame(self):
        box = crop_box(1920, 1080, [0.4, 0.4, 0.1, 0.2])
        assert inside(box, 1920, 1080)

    def test_a_subject_at_the_edge_still_gets_a_full_size_crop(self):
        # The window SLIDES back into frame rather than being clipped. Clipping
        # would hand the console a sliver for every subject at the boundary --
        # which is where a fence line lives, so it would be the common case.
        left = crop_box(1920, 1080, [0.0, 0.5, 0.05, 0.1])
        right = crop_box(1920, 1080, [0.95, 0.5, 0.05, 0.1])
        assert inside(left, 1920, 1080)
        assert inside(right, 1920, 1080)
        assert (left[2] - left[0]) == pytest.approx(right[2] - right[0], abs=2)

    def test_the_crop_is_landscape(self):
        # A tall crop of a standing person letterboxes into the console's wide
        # thumbnail and wastes most of its pixels on black.
        x1, y1, x2, y2 = crop_box(1920, 1080, [0.45, 0.3, 0.04, 0.35])
        assert (x2 - x1) / (y2 - y1) == pytest.approx(ASPECT, abs=0.05)

    def test_a_subject_larger_than_the_frame_clamps_to_it(self):
        box = crop_box(854, 480, [0.0, 0.0, 1.0, 1.0])
        assert inside(box, 854, 480)
        assert box[2] - box[0] <= 854
        assert box[3] - box[1] <= 480

    def test_a_degenerate_box_still_produces_a_usable_rectangle(self):
        # A zero-size detection should never crash the detection loop, and a
        # 0x0 crop would make cv2.imencode fail for a reason nobody could trace
        # back to here.
        box = crop_box(854, 480, [0.5, 0.5, 0.0, 0.0])
        assert inside(box, 854, 480)
        assert box[2] - box[0] >= 16

    def test_context_keeps_more_than_the_subject(self):
        # The whole point is showing WHERE the subject was. A crop tight to the
        # box could be anywhere.
        tight = crop_box(1920, 1080, [0.45, 0.45, 0.05, 0.1], context=1.0)
        roomy = crop_box(1920, 1080, [0.45, 0.45, 0.05, 0.1], context=2.0)
        assert (roomy[2] - roomy[0]) > (tight[2] - tight[0])

    def test_the_subject_stays_centred_when_there_is_room(self):
        x1, y1, x2, y2 = crop_box(1920, 1080, [0.4, 0.4, 0.1, 0.2])
        subject_cx = (0.4 + 0.05) * 1920
        assert (x1 + x2) / 2 == pytest.approx(subject_cx, abs=2)
