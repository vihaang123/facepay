"""Payment test matrix (A-H) at checkout level, real PostgreSQL, synthetic frames. Where a case is already covered in depth
elsewhere the entry says where, and a test below proves that test still exists, so the matrix cannot silently shrink.

  A  correct customer, liveness, recognition, bound authorization, explicit confirm, one transaction, receipt and both histories
       tests/test_payments_api.py::test_full_flow_merchant_to_receipt_to_both_dashboards
  B  wrong ENROLLED customer's face on A's payment         -> test_b_* below (+ test_other_customer_cannot_authenticate_as_the_owner_of_a_session)
  C  failed liveness                                       -> test_c_* below (+ test_failed_liveness_challenge_is_rejected_even_for_the_right_face)
  D  missing / stale / incompatible model                  -> tests/test_payments_api.py::test_missing_model_means_no_authorization,
       tests/test_model_readiness.py (stale, corrupt, undecryptable, version)
  E  multiple faces: a persistent second person is rejected; duplicate/stray detections of ONE face are not  -> test_e_* below
  F  authorization replay                                  -> test_reused_authorization_cannot_pay_again, test_a_ticket_cannot_be_replayed_after_it_was_used
  G  cross-session / recipient / amount authorization      -> test_authorization_for_one_session_cannot_pay_another,
       test_a_ticket_cannot_pay_another_merchants_session_a_bigger_amount_or_another_order
  H  idempotency and concurrent confirmation               -> test_simultaneous_confirmations_create_exactly_one_transaction,
       test_database_itself_refuses_a_second_successful_transaction_per_session
These are integration tests with synthetic faces. They are NOT evidence that a real webcam or real faces work.
"""

from pathlib import Path

import pytest
from sqlalchemy import func, select

from app.api import faces as faces_api
from app.main import app
from app.ml import config as cfg
from app.models import PaymentAuthorization, Transaction
from tests.payment_helpers import authenticate, b64, confirm, create_session, enroll, new_customer, new_merchant, set_threshold, start
from tests.synthetic_scenes import GOOD_TURN, BackgroundBoxDetector, sequence

SECOND = [(1, 5, 20, 70, 80)]


@pytest.fixture(autouse=True)
def scene_detector():
    app.dependency_overrides[faces_api.get_detector] = lambda: BackgroundBoxDetector()
    yield
    app.dependency_overrides.pop(faces_api.get_detector, None)


@pytest.fixture
def trained(client, db):
    a, b = new_customer(client, "Asha Rao"), new_customer(client, "Ravi Shah")
    enroll(client, a, 0)
    enroll(client, b, 1)
    assert client.post("/faces/train", headers=a["headers"]).status_code == 200
    set_threshold(db, [a["id"], b["id"]], 1000.0)
    return a, b


@pytest.fixture
def shop(client):
    return new_merchant(client, "SuperGrocery")


def nothing_authorized(db):
    db.expire_all()
    return db.scalar(select(func.count()).select_from(PaymentAuthorization)) == 0 and db.scalar(select(func.count()).select_from(Transaction)) == 0


def authenticate_frames(client, cust, sid, extra_at=None, moves=GOOD_TURN):
    ch = start(client, cust, sid)
    frames = [b64(f) for f in sequence(0, ch["challenge"], moves, extra_at=extra_at)]
    return client.post(f"/payments/sessions/{sid}/authenticate", json={"challenge_id": ch["challenge_id"], "frames": frames}, headers=cust["headers"])


def test_b_another_enrolled_customers_face_cannot_authorize_this_customers_payment(client, trained, shop, db):
    a, _ = trained
    sid = create_session(client, shop)["session_id"]
    r = authenticate(client, a, sid, identity=1)  # Ravi's face, liveness completed, on Asha's checkout
    assert r.status_code == 200 and r.json()["result"] == "REJECTED" and r.json()["reason"] == "IDENTITY_MISMATCH"
    assert r.json().get("authorization") is None
    assert nothing_authorized(db)
    assert confirm(client, a, sid, "not-a-real-ticket").status_code >= 400
    assert nothing_authorized(db)


def test_c_failed_liveness_never_authorizes_even_for_the_right_face(client, trained, shop, db):
    a, _ = trained
    sid = create_session(client, shop)["session_id"]
    r = authenticate(client, a, sid, identity=0, moves=[0.0, 0.0, 0.0, 0.0, 0.0])
    assert r.status_code == 200 and r.json()["reason"] == "LIVENESS_FAILED" and r.json().get("authorization") is None
    assert nothing_authorized(db)


def test_e_a_second_person_who_stays_in_view_blocks_the_payment(client, trained, shop, db):
    a, _ = trained
    sid = create_session(client, shop)["session_id"]
    n = cfg.AUTH_BASELINE_FRAMES + len(GOOD_TURN)
    r = authenticate_frames(client, a, sid, extra_at={i: SECOND for i in range(n)})
    assert r.status_code == 200 and r.json()["reason"] == "MULTIPLE_FACES_DETECTED" and r.json().get("authorization") is None
    assert nothing_authorized(db)


def test_e_a_stray_second_box_in_one_frame_does_not_block_a_genuine_customer(client, trained, shop, db):
    a, _ = trained
    sid = create_session(client, shop)["session_id"]
    r = authenticate_frames(client, a, sid, extra_at={cfg.AUTH_BASELINE_FRAMES + 1: SECOND})
    assert r.status_code == 200 and r.json()["result"] == "AUTHENTICATED"
    token = r.json()["authorization"]["authorization_token"]
    assert confirm(client, a, sid, token).status_code == 200  # still needs the explicit confirmation to pay
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(Transaction)) == 1


def test_the_matrix_entries_that_live_elsewhere_still_exist():
    tests = Path(__file__).parent
    where = {
        "test_payments_api.py": ["test_full_flow_merchant_to_receipt_to_both_dashboards", "test_reused_authorization_cannot_pay_again",
                                 "test_authorization_for_one_session_cannot_pay_another", "test_missing_model_means_no_authorization",
                                 "test_simultaneous_confirmations_create_exactly_one_transaction",
                                 "test_database_itself_refuses_a_second_successful_transaction_per_session",
                                 "test_other_customer_cannot_authenticate_as_the_owner_of_a_session"],
        "test_payment_security.py": ["test_a_ticket_cannot_be_replayed_after_it_was_used",
                                    "test_a_ticket_cannot_pay_another_merchants_session_a_bigger_amount_or_another_order"],
        "test_face_auth_api.py": ["test_failed_liveness_challenge_is_rejected_even_for_the_right_face"],
    }
    for file, names in where.items():
        text = (tests / file).read_text()
        for name in names:
            assert f"def {name}(" in text, f"{file}::{name} is part of the payment matrix and is missing"


def test_consent_to_face_capture_is_recorded_in_the_audit_trail_and_needs_a_customer(client, db):
    from app.models import SecurityEvent

    c = new_customer(client)
    assert client.post("/faces/consent").status_code in (401, 403)
    assert client.post("/faces/consent", headers=c["headers"]).status_code == 204
    db.expire_all()
    kinds = [e.kind for e in db.scalars(select(SecurityEvent).where(SecurityEvent.user_id == c["id"]))]
    assert kinds.count("FACE_CONSENT_GIVEN") == 1
    merchant = new_merchant(client)
    assert client.post("/faces/consent", headers=merchant["headers"]).status_code in (401, 403)
