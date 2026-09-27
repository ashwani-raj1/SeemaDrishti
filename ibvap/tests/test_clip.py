"""
core/clip.py — the ring, and the clips cut from it.

Driven with tiny real numpy frames rather than stubs, because the two things
worth pinning here are both about the frames themselves: that the ring stays
bounded, and that a clip carries the pre-roll from BEFORE the crossing. Neither
can be checked without something shaped like an image.

The frames are 8x6, so OpenCV does real work and the whole file still runs in
milliseconds and downloads nothing.
"""

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.clip import ClipRecorder  # noqa: E402


def frame(value: int = 0, width: int = 8, height: int = 6):
    return np.full((height, width, 3), value % 256, dtype=np.uint8)


def build(**over):
    params = {"pre_seconds": 4.0, "post_seconds": 2.0, "fps_hint": 6.0}
    params.update(over)
    return ClipRecorder(**params)


class TestRing:
    def test_the_ring_is_bounded_by_the_pre_roll(self):
        # The point of the ring is that it cannot grow. A leak here is a worker
        # that dies overnight on a camera nobody was watching.
        recorder = build(pre_seconds=1.0, fps_hint=6.0)
        for i in range(500):
            recorder.add(i / 6.0, frame(i))
        # depth = pre_seconds * fps + 2
        assert recorder.stats()["buffered"] <= 8

    def test_ring_bytes_are_reported(self):
        recorder = build()
        for i in range(10):
            recorder.add(i / 6.0, frame(i))
        assert recorder.stats()["ring_bytes"] == 10 * 8 * 6 * 3

    def test_a_wide_frame_is_downscaled_on_the_way_in(self):
        # Without this a 1080p camera's ring is five times the size promised.
        recorder = build(max_width=16)
        recorder.add(0.0, frame(1, width=64, height=36))
        assert recorder.stats()["ring_bytes"] == 16 * 9 * 3

    def test_the_stored_frame_does_not_alias_the_caller(self):
        # Modules receive the same array and nothing forbids one drawing on it.
        # A shared reference would make a clip's contents depend on which
        # modules ran after it was buffered.
        recorder = build()
        original = frame(5)
        recorder.add(0.0, original)
        original[:] = 200
        recorder.start("clip_a", 0.0)
        payload = recorder.collect(now=100.0)[0]
        assert len(payload["frames"]) == 1

    def test_a_none_frame_is_ignored_not_fatal(self):
        recorder = build()
        recorder.add(0.0, None)
        assert recorder.stats()["buffered"] == 0


class TestCutting:
    def test_a_clip_carries_frames_from_before_the_crossing(self):
        # THE REASON THE RING EXISTS. A clip that started at the trigger would
        # show the aftermath and never the approach.
        recorder = build()
        for i in range(12):
            recorder.add(i * 0.1, frame(i))
        recorder.start("clip_a", at=1.1)

        payload = recorder.collect(now=999.0)[0]
        offsets = [f["offset"] for f in payload["frames"]]
        assert min(offsets) < 0, "no pre-roll: the approach was not captured"
        assert max(offsets) <= 0.0001

    def test_post_roll_frames_are_added_after_the_trigger(self):
        recorder = build()
        recorder.add(0.0, frame(1))
        recorder.start("clip_a", at=0.0)
        recorder.add(0.5, frame(2))
        recorder.add(1.0, frame(3))

        payload = recorder.collect(now=999.0)[0]
        assert max(f["offset"] for f in payload["frames"]) == pytest.approx(1.0)

    def test_it_waits_for_the_post_roll(self):
        # The event goes immediately; the clip is not complete until the
        # post-roll has elapsed. Collecting early would truncate it.
        recorder = build(post_seconds=2.0)
        recorder.add(0.0, frame(1))
        recorder.start("clip_a", at=10.0)

        assert recorder.collect(now=11.0) == []
        assert len(recorder.collect(now=12.0)) == 1

    def test_force_drains_an_incomplete_clip(self):
        # Shutdown. A truncated clip of a real crossing is worth more than a
        # tidy exit that loses it.
        recorder = build(post_seconds=30.0)
        recorder.add(0.0, frame(1))
        recorder.start("clip_a", at=0.0)

        assert recorder.collect(now=1.0) == []
        assert len(recorder.collect(now=1.0, force=True)) == 1

    def test_the_same_id_cannot_open_two_clips(self):
        # Two zones can confirm on one camera in one frame. Two clips sharing
        # an id would overwrite each other on the node.
        recorder = build()
        recorder.add(0.0, frame(1))
        recorder.start("clip_a", at=0.0)
        recorder.start("clip_a", at=0.0)
        assert len(recorder.collect(now=999.0)) == 1

    def test_ids_are_unique_per_recorder(self):
        recorder = build()
        ids = {recorder.next_id("run1", "cam_a") for _ in range(5)}
        assert len(ids) == 5

    def test_a_clip_with_no_frames_is_counted_not_sent(self):
        # An empty frame list would reach the console as a player with no
        # frames and no explanation.
        recorder = build()
        recorder.start("clip_a", at=0.0)
        assert recorder.collect(now=999.0) == []
        assert recorder.stats()["dropped_empty"] == 1

    def test_the_reported_rate_is_the_observed_one(self):
        # A worker managing 4 fps must not label its clip 6 fps just because
        # that is what the config asked for.
        recorder = build(fps_hint=6.0)
        for i in range(5):
            recorder.add(i * 0.25, frame(i))   # 4 fps in reality
        recorder.start("clip_a", at=1.0)

        payload = recorder.collect(now=999.0)[0]
        assert payload["fps"] == pytest.approx(4.0, abs=0.2)

    def test_boxes_ride_along_with_each_frame(self):
        # What makes the console's overlay real rather than one box redrawn on
        # every frame.
        recorder = build()
        recorder.add(0.0, frame(1), boxes=[{"class": "vehicle", "bbox": [0, 0, 1, 1]}])
        recorder.start("clip_a", at=0.0)

        payload = recorder.collect(now=999.0)[0]
        assert payload["frames"][0]["boxes"][0]["class"] == "vehicle"

    def test_frames_are_base64_jpeg(self):
        import base64

        recorder = build()
        recorder.add(0.0, frame(1))
        recorder.start("clip_a", at=0.0)

        payload = recorder.collect(now=999.0)[0]
        raw = base64.b64decode(payload["frames"][0]["jpeg"])
        assert raw[:3] == b"\xff\xd8\xff", "not a JPEG"
