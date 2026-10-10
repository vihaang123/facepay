import numpy as np
import pytest

from app.ml import config as cfg
from app.ml import liveness as lv
from app.ml.preprocessing import Box


def obs(cx, w=100.0, faces=1):
    return lv.FrameObservation(faces, cx, w) if faces else lv.FrameObservation(0, None, None)


def seq(challenge, moves, base=300.0, w=100.0, base_jitter=0.0):
    """Observations: the baseline frames, then frames displaced by `moves` box widths TOWARD the requested side."""
    sign = -1.0 if challenge == "turn_right" else 1.0
    n = cfg.AUTH_BASELINE_FRAMES
    baseline = [obs(base + base_jitter * w * (-1 if i % 2 == 0 else 1), w) for i in range(n)]
    return baseline + [obs(base + sign * m * w, w) for m in moves]


@pytest.mark.parametrize("challenge", ["turn_right", "turn_left"])
def test_valid_challenge_passes(challenge):
    v = lv.evaluate(challenge, seq(challenge, [0.02, 0.08, 0.14, 0.15, 0.15]))
    assert v.passed and v.detail == "COMPLETED" and v.result == "PASSED" and v.toward >= cfg.LATERAL_THRESHOLD


def test_direction_convention_unmirrored_image():
    """turn_right = the user's right = image LEFT = smaller x."""
    moving_left = [obs(300)] * cfg.AUTH_BASELINE_FRAMES + [obs(300 - 15 * k) for k in range(1, 6)]
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
    assert lv.evaluate("turn_left", seq("turn_left", [0, 0, 0, t + 1e-6, t + 1e-6])).passed
    assert not lv.evaluate("turn_left", seq("turn_left", [0, 0, 0, t - 1e-3, t - 1e-3])).passed


def test_too_few_frames():
    v = lv.evaluate("turn_left", seq("turn_left", [0.2, 0.2])[: cfg.AUTH_MIN_FRAMES - 1])
    assert not v.passed and v.detail == "TOO_FEW_FRAMES"


def test_face_lost_during_challenge():
    b = cfg.AUTH_BASELINE_FRAMES
    o = seq("turn_left", [0.1, 0.2, 0.2, 0.2, 0.2, 0.2])
    for i in range(b + 1, b + 5):  # the face is gone for four frames in a row
        o[i] = obs(0, faces=0)
    assert lv.evaluate("turn_left", o).detail == "FACE_LOST"
    o2 = seq("turn_left", [0.2] * 6)
    for i in range(b):  # no usable face in the baseline at all
        o2[i] = obs(0, faces=0)
    assert lv.evaluate("turn_left", o2).detail == "FACE_LOST"
    o3 = seq("turn_left", [0.2] * 6)
    for i in (b, b + 1, b + 2, b + 4):  # lost for most of the turn, even with short runs
        o3[i] = obs(0, faces=0)
    assert lv.evaluate("turn_left", o3).detail == "FACE_LOST"


def test_one_missed_baseline_frame_is_tolerated():
    o = seq("turn_left", [0.04, 0.10, 0.16, 0.18, 0.18, 0.18])
    o[0] = obs(0, faces=0)
    assert lv.evaluate("turn_left", o).passed


def test_a_short_loss_while_turning_is_tolerated():
    """A turned head is often no longer a frontal face: two lost frames in a row during the turn are expected."""
    b = cfg.AUTH_BASELINE_FRAMES
    o = seq("turn_left", [0.04, 0.12, 0.18, 0.18, 0.18, 0.18])
    o[b + 2] = obs(0, faces=0)
    o[b + 3] = obs(0, faces=0)
    assert lv.evaluate("turn_left", o).passed


def test_one_noisy_frame_cannot_pass_the_challenge():
    """A single spike past the threshold is detector noise (or a flick), not a head turn."""
    v = lv.evaluate("turn_left", seq("turn_left", [0.0, 0.0, 0.0, 0.3, 0.0, 0.0]))
    assert not v.passed and v.detail != "COMPLETED"
    assert lv.evaluate("turn_left", seq("turn_left", [0.0, 0.0, 0.12, 0.3, 0.0, 0.0])).passed  # held for two frames


def test_one_noisy_frame_the_other_way_does_not_reject_a_real_turn():
    v = lv.evaluate("turn_left", seq("turn_left", [0.04, 0.12, 0.16, 0.18, -0.2, 0.18]))
    assert v.passed, v


def test_the_verdict_carries_a_counts_only_trace():
    v = lv.evaluate("turn_left", seq("turn_left", [0.2] * 6))
    assert "baseline_usable=" in v.trace and "turn_usable=" in v.trace and "longest_lost_run=" in v.trace


def test_two_faces_in_a_frame_is_not_usable():
    o = seq("turn_left", [0.2] * 6)
    o[cfg.AUTH_BASELINE_FRAMES + 1] = obs(380, faces=2)
    o[cfg.AUTH_BASELINE_FRAMES + 2] = obs(380, faces=2)
    assert lv.evaluate("turn_left", o).passed  # the other frames carry the challenge
    o[cfg.AUTH_BASELINE_FRAMES + 3] = obs(380, faces=2)
    o[cfg.AUTH_BASELINE_FRAMES + 4] = obs(380, faces=2)
    assert not lv.evaluate("turn_left", o).passed


def test_unstable_baseline():
    v = lv.evaluate("turn_left", seq("turn_left", [0.2] * 6, base_jitter=0.2))
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


# ---------------------------------------------------------------- distinct faces, and a second person across a sequence


def test_duplicate_detections_of_one_face_are_one_face():
    face = Box(100, 100, 100, 100)
    same_face_again = Box(104, 98, 96, 104)  # near-identical overlapping box
    inside = Box(120, 140, 50, 50)  # a smaller box nested in the face
    o = lv.observe_boxes([face, same_face_again, inside])
    assert o.faces == 1 and o.center_x == 150 and o.width == 100


def test_two_separate_people_are_two_faces():
    assert lv.observe_boxes([Box(0, 0, 100, 100), Box(300, 20, 90, 90)]).faces == 2


def test_a_second_person_who_stays_in_view_rejects_the_attempt():
    n = cfg.AUTH_BASELINE_FRAMES + 6
    present = [obs(300, faces=2) if i % 2 == 0 else obs(300) for i in range(n)]  # in view in half the frames
    assert lv.multiple_faces(present)


def test_an_isolated_stray_box_does_not_count_as_a_second_person():
    n = cfg.AUTH_BASELINE_FRAMES + 6
    frames = [obs(300) for _ in range(n)]
    frames[4] = obs(300, faces=2)
    assert not lv.multiple_faces(frames)
    frames[5] = obs(300, faces=2)
    assert not lv.multiple_faces(frames)  # two stray frames of nine
    frames[6] = obs(300, faces=2)
    assert lv.multiple_faces(frames)  # three of nine: someone is there
