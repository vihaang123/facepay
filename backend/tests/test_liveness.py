import numpy as np
import pytest

from app.ml import config as cfg
from app.ml import liveness as lv
from app.ml.preprocessing import Box


def obs(cx, w=100.0, faces=1):
    return lv.FrameObservation(faces, cx, w) if faces else lv.FrameObservation(0, None, None)


def seq(challenge, moves, base=300.0, w=100.0, base_jitter=0.0):
    """Observations: 2 baseline frames then frames displaced by `moves` box widths TOWARD the requested side."""
    sign = -1.0 if challenge == "turn_right" else 1.0
    return [obs(base - base_jitter * w, w), obs(base + base_jitter * w, w)] + [obs(base + sign * m * w, w) for m in moves]


@pytest.mark.parametrize("challenge", ["turn_right", "turn_left"])
def test_valid_challenge_passes(challenge):
    v = lv.evaluate(challenge, seq(challenge, [0.02, 0.08, 0.14, 0.15, 0.15]))
    assert v.passed and v.detail == "COMPLETED" and v.result == "PASSED" and v.toward >= cfg.LATERAL_THRESHOLD


def test_direction_convention_unmirrored_image():
    """turn_right = the user's right = image LEFT = smaller x."""
    moving_left = [obs(300), obs(300)] + [obs(300 - 15 * k) for k in range(1, 6)]
    assert lv.evaluate("turn_right", moving_left).passed
    assert lv.evaluate("turn_left", moving_left).detail == "WRONG_DIRECTION"


def test_wrong_direction_fails():
    v = lv.evaluate("turn_right", seq("turn_left", [0.05, 0.12, 0.15, 0.15, 0.15]))
    assert not v.passed and v.detail == "WRONG_DIRECTION" and v.result == "FAILED"


def test_incomplete_movement_fails():
    v = lv.evaluate("turn_left", seq("turn_left", [0.01, 0.03, 0.05, 0.06, 0.06]))
    assert not v.passed and v.detail == "INCOMPLETE_MOVEMENT"


def test_no_movement_fails():
    v = lv.evaluate("turn_left", seq("turn_left", [0.0, 0.003, -0.004, 0.002, 0.0]))
    assert not v.passed and v.detail == "NO_MOVEMENT"


def test_moving_both_ways_is_ambiguous():
    v = lv.evaluate("turn_left", seq("turn_left", [0.12, -0.12, 0.12, -0.12, 0.0]))
    assert not v.passed and v.detail == "AMBIGUOUS_MOTION"


def test_threshold_boundary():
    t = cfg.LATERAL_THRESHOLD
    assert lv.evaluate("turn_left", seq("turn_left", [0, 0, 0, 0, t + 1e-6])).passed
    assert not lv.evaluate("turn_left", seq("turn_left", [0, 0, 0, 0, t - 1e-3])).passed


def test_too_few_frames():
    v = lv.evaluate("turn_left", seq("turn_left", [0.2, 0.2])[: cfg.AUTH_MIN_FRAMES - 1])
    assert not v.passed and v.detail == "TOO_FEW_FRAMES"


def test_face_lost_during_challenge():
    o = seq("turn_left", [0.1, 0.2, 0.2, 0.2, 0.2])
    for i in (3, 4, 5):
        o[i] = obs(0, faces=0)
    assert lv.evaluate("turn_left", o).detail == "FACE_LOST"
    o2 = seq("turn_left", [0.2] * 5)
    o2[0] = obs(0, faces=0)  # no face in the baseline
    assert lv.evaluate("turn_left", o2).detail == "FACE_LOST"


def test_two_faces_in_a_frame_is_not_usable():
    o = seq("turn_left", [0.2] * 5)
    o[4] = obs(380, faces=2)
    o[5] = obs(380, faces=2)
    assert not lv.evaluate("turn_left", o).passed


def test_unstable_baseline():
    v = lv.evaluate("turn_left", seq("turn_left", [0.2] * 5, base_jitter=0.2))
    assert not v.passed and v.detail == "UNSTABLE_BASELINE"


def test_measured_detector_jitter_never_passes_a_static_scene():
    """A photo that does not move: jitter up to the worst value measured on real faces (0.018 box widths)."""
    rng = np.random.default_rng(0)
    worst = 0.018
    for _ in range(2000):
        o = [obs(300 + rng.uniform(-worst, worst) * 100) for _ in range(9)]
        assert not lv.evaluate("turn_right", o).passed


def test_threshold_is_well_above_measured_jitter():
    assert cfg.LATERAL_THRESHOLD >= 5 * 0.018


def test_observe_boxes_counts_only_significant_faces():
    big, small, tiny = Box(0, 0, 100, 100), Box(200, 0, 50, 50), Box(300, 0, 20, 20)
    assert lv.observe_boxes([]).faces == 0
    assert lv.observe_boxes([big, tiny]).faces == 1  # 4% of the area: ignored
    assert lv.observe_boxes([big, small]).faces == 2  # 25% >= 15%: counts
    o = lv.observe_boxes([small, big])
    assert o.center_x == 50 and o.width == 100  # the largest face is tracked
