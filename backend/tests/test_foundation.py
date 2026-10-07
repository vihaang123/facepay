from decimal import Decimal

import pytest
from sqlalchemy import inspect
from sqlalchemy.exc import IntegrityError

from app.database.session import engine
from app.models import Merchant, Transaction, User


def test_health_reports_database_ok(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["database"] == "ok"


def test_cors_allows_configured_origin(client):
    r = client.options(
        "/health",
        headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"},
    )
    assert r.headers.get("access-control-allow-origin") == "http://localhost:5173"


def test_cors_rejects_unknown_origin(client):
    r = client.options(
        "/health",
        headers={"Origin": "http://evil.example", "Access-Control-Request-Method": "GET"},
    )
    assert "access-control-allow-origin" not in r.headers


def test_all_expected_tables_exist():
    tables = set(inspect(engine).get_table_names())
    expected = {"users", "merchants", "face_profiles", "transactions", "authentication_logs", "model_versions"}
    assert expected <= tables


def test_user_email_unique(db):
    db.add(User(name="A", email="dup@example.com", password_hash="x"))
    db.flush()
    db.add(User(name="B", email="dup@example.com", password_hash="y"))
    with pytest.raises(IntegrityError):
        db.flush()


def test_transaction_amount_must_be_positive(db):
    u = User(name="P", email="payer@example.com", password_hash="x")
    m = Merchant(name="M", email="m@example.com", business_name="Shop", password_hash="x")
    db.add_all([u, m])
    db.flush()
    db.add(Transaction(transaction_id="FP-TEST-0001", payer_id=u.id, merchant_id=m.id, amount=Decimal("0")))
    with pytest.raises(IntegrityError):
        db.flush()


def test_transaction_status_constrained(db):
    u = User(name="P2", email="payer2@example.com", password_hash="x")
    m = Merchant(name="M2", email="m2@example.com", business_name="Shop2", password_hash="x")
    db.add_all([u, m])
    db.flush()
    db.add(
        Transaction(
            transaction_id="FP-TEST-0002", payer_id=u.id, merchant_id=m.id,
            amount=Decimal("10.00"), status="BOGUS",
        )
    )
    with pytest.raises(IntegrityError):
        db.flush()
