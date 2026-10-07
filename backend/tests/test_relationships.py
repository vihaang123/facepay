"""Proves the schema supports the FacePay flow:
User -> FaceProfile -> AuthenticationLogs -> Transactions
Merchant -> PaymentSessions -> Transactions
"""

from decimal import Decimal

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.models import (
    AuthenticationLog,
    FaceProfile,
    Merchant,
    ModelVersion,
    PaymentSession,
    Transaction,
    User,
)


def _user(db, n=1):
    u = User(name=f"U{n}", email=f"u{n}@example.com", password_hash="x")
    db.add(u)
    db.flush()
    return u


def _merchant(db, n=1):
    m = Merchant(name=f"M{n}", email=f"m{n}@example.com", business_name="Shop", password_hash="x")
    db.add(m)
    db.flush()
    return m


def test_full_flow_relationships(db):
    user, merchant = _user(db), _merchant(db)
    mv = ModelVersion(version="v-test", status="active")
    db.add(mv)
    db.flush()
    db.add(FaceProfile(user_id=user.id, model_version_id=mv.id, sample_count=5))
    db.add(AuthenticationLog(user_id=user.id, result="SUCCESS", confidence=0.93, liveness_result="PASSED"))
    ps = PaymentSession(session_id="PS-TEST-1", merchant_id=merchant.id, amount=Decimal("1240.00"))
    db.add(ps)
    db.flush()
    tx = Transaction(
        transaction_id="FP-TEST-1", payer_id=user.id, merchant_id=merchant.id,
        payment_session_id=ps.id, amount=Decimal("1240.00"), status="SUCCESS",
    )
    db.add(tx)
    db.commit()
    db.expire_all()

    u = db.get(User, user.id)
    assert len(u.face_profiles) == 1 and u.face_profiles[0].sample_count == 5
    assert len(u.authentication_logs) == 1 and u.authentication_logs[0].result == "SUCCESS"
    assert len(u.transactions) == 1
    m = db.get(Merchant, merchant.id)
    assert len(m.payment_sessions) == 1 and len(m.transactions) == 1
    assert m.payment_sessions[0].transactions[0].transaction_id == "FP-TEST-1"
    assert db.get(Transaction, tx.id).payment_session.session_id == "PS-TEST-1"
    assert db.get(Transaction, tx.id).payer.id == user.id


def test_transaction_without_payment_session_is_allowed(db):
    u, m = _user(db), _merchant(db)
    db.add(Transaction(transaction_id="FP-TEST-2", payer_id=u.id, merchant_id=m.id, amount=Decimal("5")))
    db.flush()  # no IntegrityError


def test_payment_session_amount_and_status_constraints(db):
    m = _merchant(db)
    db.add(PaymentSession(session_id="PS-BAD-1", merchant_id=m.id, amount=Decimal("-1")))
    with pytest.raises(IntegrityError):
        db.flush()
    db.rollback()
    m = _merchant(db, 2)
    db.add(PaymentSession(session_id="PS-BAD-2", merchant_id=m.id, amount=Decimal("1"), status="WEIRD"))
    with pytest.raises(IntegrityError):
        db.flush()


def test_payment_session_requires_real_merchant_and_unique_id(db):
    db.add(PaymentSession(session_id="PS-ORPHAN", merchant_id=9999, amount=Decimal("1")))
    with pytest.raises(IntegrityError):
        db.flush()
    db.rollback()
    m = _merchant(db)
    db.add(PaymentSession(session_id="PS-DUP", merchant_id=m.id, amount=Decimal("1")))
    db.flush()
    db.add(PaymentSession(session_id="PS-DUP", merchant_id=m.id, amount=Decimal("2")))
    with pytest.raises(IntegrityError):
        db.flush()


def test_transaction_cannot_point_to_missing_payment_session(db):
    u, m = _user(db), _merchant(db)
    db.add(Transaction(transaction_id="FP-X", payer_id=u.id, merchant_id=m.id, amount=Decimal("1"), payment_session_id=424242))
    with pytest.raises(IntegrityError):
        db.flush()


def test_deleting_user_cascades_face_profiles_and_keeps_failed_auth_logs(db):
    u = _user(db)
    db.add(FaceProfile(user_id=u.id, sample_count=3))
    db.add(AuthenticationLog(user_id=u.id, result="FAILED"))
    db.commit()
    uid = u.id
    db.delete(db.get(User, uid))
    db.commit()
    assert db.scalar(select(FaceProfile).where(FaceProfile.user_id == uid)) is None
    log = db.scalar(select(AuthenticationLog))
    assert log is not None and log.user_id is None  # audit trail survives, detached
