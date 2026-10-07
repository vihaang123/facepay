import pytest

from app.services.auth_policy import REASONS, Decision, Evidence, FrameIdentity, IMAGE_ERROR_REASON, decide

GOOD = FrameIdentity(True, 0.9, 3.0)


def ev(**kw):
    base = dict(liveness_passed=True, frames=(GOOD, GOOD), distance_threshold=5.0)
    base.update(kw)
    return Evidence(**base)


def test_all_checks_pass():
    d = decide(ev())
    assert d.authenticated and d.result == "AUTHENTICATED" and d.reason is None


@pytest.mark.parametrize(
    "kwargs,reason",
    [
        (dict(account_active=False), "ACCOUNT_DISABLED"),
        (dict(challenge="INVALID"), "CHALLENGE_INVALID"),
        (dict(challenge="EXPIRED"), "CHALLENGE_EXPIRED"),
        (dict(model_available=False), "MODEL_UNAVAILABLE"),
        (dict(enrolled=False), "NOT_ENROLLED"),
        (dict(image_reason=IMAGE_ERROR_REASON["NO_FACE"]), "FACE_NOT_DETECTED"),
        (dict(image_reason=IMAGE_ERROR_REASON["MULTIPLE_FACES"]), "MULTIPLE_FACES_DETECTED"),
        (dict(image_reason=IMAGE_ERROR_REASON["TOO_BLURRY"]), "POOR_IMAGE_QUALITY"),
        (dict(liveness_passed=False, liveness_detail="NO_MOVEMENT"), "LIVENESS_FAILED"),
        (dict(liveness_passed=None), "LIVENESS_FAILED"),
        (dict(frames=(GOOD, FrameIdentity(False, 0.9, 3.0))), "IDENTITY_MISMATCH"),
        (dict(frames=(GOOD, FrameIdentity(True, 0.49, 3.0))), "LOW_CONFIDENCE"),
        (dict(frames=(GOOD, FrameIdentity(True, 0.9, 5.01))), "DISTANCE_TOO_HIGH"),
        (dict(frames=()), "IDENTITY_MISMATCH"),
    ],
)
def test_each_failure_has_its_reason(kwargs, reason):
    d = decide(ev(**kwargs))
    assert not d.authenticated and d.result == "REJECTED" and d.reason == reason


def test_every_reason_the_policy_can_emit_is_documented():
    emitted = {decide(ev(**k)).reason for k in (
        dict(account_active=False), dict(challenge="INVALID"), dict(challenge="EXPIRED"), dict(model_available=False),
        dict(enrolled=False), dict(liveness_passed=False), dict(frames=(FrameIdentity(False, 1, 0),)),
        dict(frames=(FrameIdentity(True, 0.1, 0),)), dict(frames=(FrameIdentity(True, 1, 99),)))}
    emitted |= {r for r, _ in IMAGE_ERROR_REASON.values()}
    assert emitted <= set(REASONS)


def test_liveness_detail_is_passed_through():
    assert decide(ev(liveness_passed=False, liveness_detail="WRONG_DIRECTION")).detail == "WRONG_DIRECTION"


def test_precedence_account_before_everything_and_liveness_before_identity():
    worst = ev(account_active=False, challenge="INVALID", model_available=False, liveness_passed=False)
    assert decide(worst).reason == "ACCOUNT_DISABLED"
    # a wrong face that also fails liveness is reported as a liveness failure (identity not disclosed)
    assert decide(ev(liveness_passed=False, frames=(FrameIdentity(False, 0, 99),))).reason == "LIVENESS_FAILED"
    # identity mismatch beats low confidence beats distance
    bad = FrameIdentity(False, 0.1, 99)
    assert decide(ev(frames=(bad,))).reason == "IDENTITY_MISMATCH"
    assert decide(ev(frames=(FrameIdentity(True, 0.1, 99),))).reason == "LOW_CONFIDENCE"


def test_one_good_frame_is_not_enough():
    assert not decide(ev(frames=(GOOD, FrameIdentity(True, 0.9, 50.0)))).authenticated


def test_confidence_floor_boundary_and_override():
    assert decide(ev(frames=(FrameIdentity(True, 0.5, 1.0),))).authenticated
    assert decide(ev(frames=(FrameIdentity(True, 0.7, 1.0),)), min_confidence=0.8).reason == "LOW_CONFIDENCE"


def test_distance_boundary_is_inclusive():
    assert decide(ev(frames=(FrameIdentity(True, 0.9, 5.0),))).authenticated


def test_decision_value_object():
    assert Decision(True).result == "AUTHENTICATED" and Decision(False, "X").result == "REJECTED"
