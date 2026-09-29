"""
modules/fence.py — the crossing state machine.

Driven directly with synthetic detections: no camera, no model, no node.
`FenceModule.process()` never dereferences `frame`, so `None` is a valid frame
here and OpenCV is never involved.

What these pin down is the behaviour the docstring at the top of fence.py
promises and that nothing else can check: that flicker is rejected, that a
genuine crossing is not, that inbound and outbound are two facts rather than
one, and that a shape nobody drew is still reported.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from modules.base import FrameContext  # noqa: E402
from modules.fence import FenceModule  # noqa: E402

FPS = 6.0

LINE = {
    "id": "zn_line", "name": "North fence", "kind": "fence_line",
    "geometry": "line", "points": [[0.05, 0.50], [0.95, 0.50]],
    "direction": "both", "confirm_seconds": 0.0, "classes": [],
}


def zone(**over):
    return {**LINE, **over}


def detection(x, y, klass="person", ref="r0:7"):
    """One detection, shaped exactly as core/detection.py emits it."""
    return {
        "track_ref": ref, "track_id": 7, "class": klass, "confidence": 0.9,
        "bbox_xywh": [x - 0.02, y - 0.10, 0.04, 0.10],
        "bbox": [x - 0.02, y - 0.10, x + 0.02, y],
        "ground": (x, y),
    }


def walk(module, path, klass="person", ref="r0:7", start=0):
    """Feed a path of ground points; return every durable event raised."""
    events = []
    for offset, (x, y) in enumerate(path):
        index = start + offset
        ctx = FrameContext("cam_test", index / FPS, 640, 480, index)
        _, durable = module.process(None, [detection(x, y, klass, ref)], ctx)
        events.extend(durable)
    return events


_DEFAULT = object()


def build(zones=_DEFAULT, **params):
    # Sentinel, not `or`: an explicitly EMPTY zone list is a case worth testing
    # and `zones or [zone()]` would quietly replace it with the default.
    chosen = [zone()] if zones is _DEFAULT else zones
    return FenceModule("cam_test", {"zones": chosen, **params})


# A straight walk from above the line to well below it.
THROUGH = [(0.5, 0.20 + i * 0.05) for i in range(12)]


class TestConfirming:
    def test_a_clean_walk_confirms_once(self):
        module = build(confirm_frames=3)
        events = walk(module, THROUGH)

        assert len(events) == 1
        assert events[0]["data"]["direction"] == "inbound"
        assert events[0]["data"]["rule"] == "zone.crossing.confirmed"
        assert module.stats()["confirmed"] == 1

    def test_the_on_the_line_walk_confirms_too(self):
        # THE REGRESSION, at module level. This exact path -- whose samples land
        # on y = 0.50 exactly -- used to yield confirmed=0, rejected_flicker=1:
        # a missed intrusion, disguised as the debounce working correctly.
        module = build(confirm_frames=3)
        events = walk(module, THROUGH)

        # y = 0.20 + 6*0.05 lands on the line to within EPSILON, which is the
        # trigger. One row in 480 does on a real pixel grid.
        assert any(abs(y - 0.50) < 1e-9 for _, y in THROUGH)
        assert [e["data"]["direction"] for e in events] == ["inbound"]
        assert module.stats()["rejected_flicker"] == 0

    def test_a_crossing_needs_confirm_frames_of_evidence(self):
        # Two frames of evidence must not satisfy a three-frame window.
        module = build(confirm_frames=5)
        assert walk(module, THROUGH[:8]) == []

    def test_no_zones_means_the_module_does_nothing(self):
        module = build(zones=[])
        assert walk(module, THROUGH) == []
        assert module.stats()["zones"] == 0


class TestRejecting:
    def test_jitter_astride_the_line_confirms_nothing(self):
        module = build(confirm_frames=3)
        jitter = [(0.5, 0.49 if i % 2 == 0 else 0.51) for i in range(20)]

        assert walk(module, jitter) == []
        assert module.stats()["confirmed"] == 0
        assert module.stats()["rejected_flicker"] > 0

    def test_a_zone_watching_the_other_way_ignores_the_crossing(self):
        module = build(zones=[zone(direction="outbound")], confirm_frames=3)
        assert walk(module, THROUGH) == []

    def test_a_class_the_zone_does_not_name_is_not_judged(self):
        module = build(zones=[zone(classes=["person"])], confirm_frames=3)
        assert walk(module, THROUGH, klass="cattle") == []

    def test_a_zone_with_too_few_points_is_skipped_not_judged(self):
        module = build(zones=[zone(points=[[0.5, 0.5]])])
        assert module.stats()["zones"] == 0

    def test_a_detection_with_no_track_ref_is_dropped(self):
        # A crossing needs two positions of the SAME subject.
        module = build(confirm_frames=1)
        ctx = FrameContext("cam_test", 0.0, 640, 480, 0)
        anonymous = {**detection(0.5, 0.9), "track_ref": None}
        live, durable = module.process(None, [anonymous], ctx)
        assert live == [] and durable == []


class TestDirectionAndCooldown:
    def test_in_and_back_out_are_two_separate_facts(self):
        # Cooldown is keyed per direction precisely so the exit an investigator
        # goes looking for is not suppressed as a duplicate of the entry.
        module = build(confirm_frames=3, cooldown_seconds=1.0)
        path = (
            [(0.5, 0.20 + i * 0.05) for i in range(9)]
            + [(0.5, 0.60)] * 6
            + [(0.5, 0.60 - i * 0.05) for i in range(9)]
        )
        directions = [e["data"]["direction"] for e in walk(module, path)]
        assert directions == ["inbound", "outbound"]

    def test_cooldown_suppresses_a_repeat_in_the_same_direction(self):
        module = build(confirm_frames=1, cooldown_seconds=600.0)
        first = walk(module, THROUGH)
        # Step back over and in again, well inside the cooldown window.
        again = walk(module, list(reversed(THROUGH)) + THROUGH, start=100)
        inbound = [e for e in first + again if e["data"]["direction"] == "inbound"]
        assert len(inbound) == 1


class TestPayload:
    def test_the_durable_payload_carries_the_provisional_flag(self):
        module = build(zones=[zone(provisional=True)], confirm_frames=2)
        events = walk(module, THROUGH)
        assert events and events[0]["data"]["provisional"] is True
        assert module.stats()["provisional_zones"] == 1

    def test_a_drawn_zone_is_not_flagged(self):
        module = build(zones=[zone(provisional=False)], confirm_frames=2)
        events = walk(module, THROUGH)
        assert events and events[0]["data"]["provisional"] is False

    def test_a_cached_zone_is_marked_stale(self):
        module = build(zones=[zone(stale=True, cached_at=1_700_000_000.0)], confirm_frames=2)
        events = walk(module, THROUGH)
        assert events and events[0]["data"]["stale"] is True

    def test_it_never_reports_a_severity(self):
        # Severity follows the zone's operator-editable targets on the node.
        # This module must stay ignorant of it.
        module = build(confirm_frames=2)
        data = walk(module, THROUGH)[0]["data"]
        assert "severity" not in data


class TestLostTracks:
    def test_a_track_lost_mid_crossing_is_reported_as_such(self):
        # Somebody stepping out of view exactly at the fence line is a real
        # signal, not an absence of one -- but it is not a confirmed crossing.
        module = build(confirm_frames=5)
        walk(module, [(0.5, 0.20), (0.5, 0.40), (0.5, 0.55)])

        _, durable = module.process(None, [], FrameContext("cam_test", 999.0, 640, 480, 99))
        assert [e["data"]["rule"] for e in durable] == ["zone.crossing.unconfirmed_track_lost"]
        assert module.stats()["lost_mid_crossing"] == 1

    def test_it_carries_the_last_real_observation_not_zeros(self):
        # This shipped wrong: the lost path built a synthetic detection with
        # confidence 0.0 and no box, so the console showed "vehicle 0%" for
        # every subject that walked out of frame mid-crossing -- reading as a
        # detection nobody believed rather than one that was lost.
        module = build(confirm_frames=5)
        walk(module, [(0.5, 0.20), (0.5, 0.40), (0.5, 0.55)])

        _, durable = module.process(None, [], FrameContext("cam_test", 999.0, 640, 480, 99))
        data = durable[0]["data"]
        assert data["confidence"] == 0.9          # what the detector last said
        assert data["bbox"] is not None           # where it last was

    def test_it_carries_the_picture_from_when_the_subject_was_there(self, monkeypatch):
        # A lost crossing has NO current frame by definition, so the thumbnail
        # has to be cut when the crossing starts and carried. Cutting it at
        # confirm time meant the crossings most worth looking at -- somebody
        # stepping out of view on the line -- were the only ones with nothing
        # to look at.
        #
        # Stubbed rather than encoded so this file keeps its no-OpenCV,
        # no-image property; what is under test is the carrying, not the JPEG.
        import modules.fence as fence

        monkeypatch.setattr(fence, "thumbnail_of", lambda frame, bbox: "PICTURE")

        module = build(confirm_frames=5)
        walk(module, [(0.5, 0.20), (0.5, 0.40), (0.5, 0.55)])

        _, durable = module.process(None, [], FrameContext("cam_test", 999.0, 640, 480, 99))
        assert durable[0]["data"]["thumbnail"] == "PICTURE"

    def test_a_confirmed_crossing_uses_the_crossing_frame_not_a_later_one(self, monkeypatch):
        # The frame that matters is the one the subject crossed on. By the time
        # a crossing confirms, a vehicle has usually left the shot -- so cutting
        # at confirm produced a photograph of empty ground as the evidence for
        # "something crossed here".
        import modules.fence as fence

        frames: list[int] = []

        def stub(frame, bbox):
            frames.append(frame)
            return f"PICTURE-{frame}"

        monkeypatch.setattr(fence, "thumbnail_of", stub)

        module = build(confirm_frames=3)
        events = []
        for index, (x, y) in enumerate(THROUGH):
            ctx = FrameContext("cam_test", index / FPS, 640, 480, index)
            # The "frame" is just an integer here, so the assertion can name
            # exactly which one was kept.
            _, durable = module.process(index, [detection(x, y)], ctx)
            events.extend(durable)

        assert len(events) == 1
        # Exactly one encode for the whole crossing, and it is the first frame
        # on the far side -- not the frame that happened to confirm it.
        assert len(frames) == 1
        assert events[0]["data"]["thumbnail"] == f"PICTURE-{frames[0]}"


class TestReconfigure:
    def test_a_removed_zone_drops_its_per_track_judgement(self):
        module = build(confirm_frames=5)
        walk(module, THROUGH[:6])
        module.configure({"zones": [], "confirm_frames": 5})

        # The pending crossing went with the zone; nothing can confirm against
        # geometry the operator has deleted.
        assert walk(module, THROUGH[6:], start=6) == []

    def test_module_params_survive_a_zone_refresh(self):
        module = build(confirm_frames=4, cooldown_seconds=30.0)
        module.configure({"zones": [zone()], "confirm_frames": 4, "cooldown_seconds": 30.0})
        assert module.confirm_frames == 4
        assert module.cooldown_seconds == 30.0
