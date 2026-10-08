"""Phase 6: response hardening, production configuration checks, limiter housekeeping, and the
transaction filter/sort/search and spending-summary endpoints (real PostgreSQL)."""

import os
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import pytest

from app.core.config import Settings
from app.core.rate_limit import RateLimiter
from app.models import PaymentSession, Transaction

BACKEND = Path(__file__).resolve().parents[1]
GOOD_KEY = "dGVzdC1rZXktZm9yLXRlc3RzLW9ubHktMzItYnl0ZXM="


# ------------------------------------------------------------ response headers and size cap


def test_every_response_is_uncacheable_and_has_protective_headers(client, customer):
    for r in (client.get("/health"), client.get("/users/me", headers=customer["headers"]), client.get("/users/me"), client.get("/nope")):
        assert r.headers["cache-control"] == "no-store"
        assert r.headers["x-content-type-options"] == "nosniff"
        assert r.headers["referrer-policy"] == "no-referrer"
        assert r.headers["x-frame-options"] == "DENY"


def test_oversized_request_bodies_are_refused_before_parsing(client, customer):
    big = "x" * 12_500_000
    r = client.post("/faces/recognize", content=big, headers={**customer["headers"], "Content-Type": "application/json"})
    assert r.status_code == 413 and r.json() == {"detail": "Request body is too large."}
    assert r.headers["cache-control"] == "no-store"


def test_normal_sized_requests_still_pass(client, customer):
    r = client.patch("/users/me", json={"name": "New Name"}, headers=customer["headers"])
    assert r.status_code == 200


# ------------------------------------------------------------ production configuration


def make(**kw):
    base = dict(database_url="postgresql+psycopg://u:p@h/db", jwt_secret="a-long-random-secret-value-123", _env_file=None)
    return Settings(**{**base, **kw})


def test_development_defaults_still_work():
    assert not make().is_production


@pytest.mark.parametrize("given", ["postgres://u:p@h:5432/db", "postgresql://u:p@h:5432/db", "postgresql+psycopg://u:p@h:5432/db"])
def test_hosted_database_urls_use_the_psycopg_driver(given):
    assert make(database_url=given).database_url == "postgresql+psycopg://u:p@h:5432/db"


def test_production_requires_a_biometric_key():
    with pytest.raises(ValueError, match="BIOMETRIC_KEY"):
        make(app_env="production", biometric_key="")


def test_production_rejects_the_example_jwt_secret():
    with pytest.raises(ValueError, match="placeholder"):
        make(app_env="production", biometric_key=GOOD_KEY, jwt_secret="change-me-to-a-long-random-string")


@pytest.mark.parametrize("bad", ["not-base64!!", "c2hvcnQ="])
def test_production_rejects_a_malformed_biometric_key_at_startup(bad):
    with pytest.raises(ValueError, match="BIOMETRIC_KEY"):
        make(app_env="production", biometric_key=bad)


@pytest.mark.parametrize("bad", ["*", "https://a.example,*", " , "])
def test_production_rejects_wildcard_or_empty_cors(bad):
    with pytest.raises(ValueError, match="CORS_ORIGINS"):
        make(app_env="production", biometric_key=GOOD_KEY, cors_origins=bad)


def test_production_accepts_an_exact_https_origin():
    s = make(app_env="production", biometric_key=GOOD_KEY, cors_origins="https://facepay.example.app")
    assert s.cors_origin_list == ["https://facepay.example.app"]


def test_production_with_real_secrets_is_accepted():
    assert make(app_env="production", biometric_key=GOOD_KEY).is_production


def test_api_docs_are_only_served_in_development(client):
    assert client.get("/docs").status_code == 200
    env = {**os.environ, "APP_ENV": "production", "BIOMETRIC_KEY": GOOD_KEY, "JWT_SECRET": "a-long-random-secret-value-123", "PYTHONPATH": str(BACKEND)}
    code = "from app.main import app; print(app.docs_url, app.redoc_url, app.openapi_url)"
    out = subprocess.run([sys.executable, "-c", code], env=env, cwd=BACKEND, capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip().splitlines()[-1] == "None None None"


# ------------------------------------------------------------ rate limiter housekeeping


def test_rate_limiter_forgets_clients_that_never_return(monkeypatch):
    from app.core import rate_limit

    monkeypatch.setattr(rate_limit, "_MAX_KEYS", 10)
    limiter = RateLimiter(5, window_seconds=60)
    for i in range(50):
        limiter._hits[f"old{i}"].append(0.0)  # long ago (monotonic clock starts near boot, so 0 is outside the window)
    assert limiter.allow("fresh")
    assert len(limiter._hits) <= 2 and "fresh" in limiter._hits


def test_rate_limiter_still_limits_after_housekeeping(monkeypatch):
    from app.core import rate_limit

    monkeypatch.setattr(rate_limit, "_MAX_KEYS", 0)
    limiter = RateLimiter(2, window_seconds=60)
    assert [limiter.allow("k") for _ in range(4)] == [True, True, False, False]


def test_deleting_face_data_is_rate_limited(client, customer, monkeypatch):
    from app.api import faces as faces_api

    monkeypatch.setattr(faces_api.face_limiter, "enabled", True)
    monkeypatch.setattr(faces_api.face_limiter, "max_requests", 2)
    faces_api.face_limiter.reset()
    codes = [client.delete("/faces/samples", headers=customer["headers"]).status_code for _ in range(4)]
    faces_api.face_limiter.reset()
    assert codes == [204, 204, 429, 429]


# ------------------------------------------------------------ transaction lists


@pytest.fixture
def ledger(client, db, customer, merchant):
    """One customer paying one merchant five times, plus another customer's and another merchant's rows."""
    from tests.payment_helpers import new_customer, new_merchant

    other_cust, other_merch = new_customer(client, "Other Person"), new_merchant(client, "Cafe_Chai 100%")
    now = datetime.now(UTC)
    rows = [  # (payer, merchant, ref, amount, status, days ago, id)
        (customer["id"], merchant["id"], "SG-1", "100.00", "SUCCESS", 1, "FP-AAAAAAAA01"),
        (customer["id"], merchant["id"], "SG-2", "250.50", "SUCCESS", 3, "FP-AAAAAAAA02"),
        (customer["id"], merchant["id"], "SG-3", "75.00", "FAILED", 5, "FP-AAAAAAAA03"),
        (customer["id"], other_merch["id"], "CC-1", "40.00", "SUCCESS", 40, "FP-BBBBBBBB01"),
        (customer["id"], other_merch["id"], "CC-2", "500.00", "PENDING", 2, "FP-BBBBBBBB02"),
        (other_cust["id"], merchant["id"], "SG-9", "999.00", "SUCCESS", 1, "FP-CCCCCCCC01"),
    ]
    for payer, merch, ref, amount, status, days, tid in rows:
        ps = PaymentSession(session_id=f"ps_{tid}", merchant_id=merch, amount=Decimal(amount), order_reference=ref, status="PAID")
        db.add(ps)
        db.flush()
        db.add(Transaction(transaction_id=tid, payer_id=payer, merchant_id=merch, payment_session_id=ps.id, amount=Decimal(amount),
                           status=status, timestamp=now - timedelta(days=days)))
    db.commit()
    return {"other_cust": other_cust, "other_merch": other_merch}


def ids(r):
    assert r.status_code == 200, r.text
    return [t["transaction_id"] for t in r.json()]


def test_customer_list_default_order_and_isolation(client, customer, ledger):
    got = ids(client.get("/payments/transactions", headers=customer["headers"]))
    assert got == ["FP-BBBBBBBB02", "FP-BBBBBBBB01", "FP-AAAAAAAA03", "FP-AAAAAAAA02", "FP-AAAAAAAA01"]  # newest first
    assert "FP-CCCCCCCC01" not in got  # never another customer's row


@pytest.mark.parametrize(
    "sort, expected",
    [
        ("newest", ["FP-BBBBBBBB02", "FP-BBBBBBBB01", "FP-AAAAAAAA03", "FP-AAAAAAAA02", "FP-AAAAAAAA01"]),  # by creation order (id)
        ("oldest", ["FP-AAAAAAAA01", "FP-AAAAAAAA02", "FP-AAAAAAAA03", "FP-BBBBBBBB01", "FP-BBBBBBBB02"]),
        ("amount_desc", ["FP-BBBBBBBB02", "FP-AAAAAAAA02", "FP-AAAAAAAA01", "FP-AAAAAAAA03", "FP-BBBBBBBB01"]),
        ("amount_asc", ["FP-BBBBBBBB01", "FP-AAAAAAAA03", "FP-AAAAAAAA01", "FP-AAAAAAAA02", "FP-BBBBBBBB02"]),
    ],
)
def test_customer_sorting(client, customer, ledger, sort, expected):
    assert ids(client.get(f"/payments/transactions?sort={sort}", headers=customer["headers"])) == expected


def test_customer_status_filter_search_and_paging(client, customer, ledger):
    h = customer["headers"]
    assert sorted(ids(client.get("/payments/transactions?status=SUCCESS", headers=h))) == ["FP-AAAAAAAA01", "FP-AAAAAAAA02", "FP-BBBBBBBB01"]
    assert ids(client.get("/payments/transactions?status=FAILED", headers=h)) == ["FP-AAAAAAAA03"]
    assert ids(client.get("/payments/transactions?q=sg-2", headers=h)) == ["FP-AAAAAAAA02"]  # order reference, case-insensitive
    assert ids(client.get("/payments/transactions?q=supergrocery&status=SUCCESS&sort=amount_desc", headers=h)) == ["FP-AAAAAAAA02", "FP-AAAAAAAA01"]
    assert ids(client.get("/payments/transactions?q=BBBBBBBB01", headers=h)) == ["FP-BBBBBBBB01"]  # transaction id
    assert ids(client.get("/payments/transactions?q=nothing-like-this", headers=h)) == []
    page1 = ids(client.get("/payments/transactions?limit=2&offset=0&sort=oldest", headers=h))
    page2 = ids(client.get("/payments/transactions?limit=2&offset=2&sort=oldest", headers=h))
    page3 = ids(client.get("/payments/transactions?limit=2&offset=4&sort=oldest", headers=h))
    assert page1 + page2 + page3 == ["FP-AAAAAAAA01", "FP-AAAAAAAA02", "FP-AAAAAAAA03", "FP-BBBBBBBB01", "FP-BBBBBBBB02"]
    assert len(ids(client.get("/payments/transactions?limit=101", headers=h))) == 5


def test_search_text_is_data_not_a_pattern(client, customer, ledger):
    h = customer["headers"]
    # a lone '%' matches only rows that literally contain '%' (the merchant name "Cafe_Chai 100%"), not everything
    assert sorted(ids(client.get("/payments/transactions?q=%25", headers=h))) == ["FP-BBBBBBBB01", "FP-BBBBBBBB02"]
    # the merchant name "Cafe_Chai 100%" really contains '_' and '%': only those rows match, wildcards do not leak
    assert sorted(ids(client.get("/payments/transactions?q=Cafe_Chai", headers=h))) == ["FP-BBBBBBBB01", "FP-BBBBBBBB02"]
    assert ids(client.get("/payments/transactions?q=Cafe%25Chai", headers=h)) == []
    assert ids(client.get("/payments/transactions?q=Cafe-Chai", headers=h)) == []
    assert ids(client.get("/payments/transactions?q=_", headers=h)) != []  # literal underscore (in the merchant name), not "any char"
    assert len(ids(client.get("/payments/transactions?q=100%25", headers=h))) == 2
    assert ids(client.get("/payments/transactions?q=SG-%25", headers=h)) == []  # '%' is not a wildcard


@pytest.mark.parametrize("query", ["status=BOGUS", "sort=price", "limit=0", "limit=102", "offset=-1", "q=" + "x" * 61, "status=success"])
def test_invalid_list_parameters_are_422(client, customer, merchant, query):
    assert client.get(f"/payments/transactions?{query}", headers=customer["headers"]).status_code == 422
    assert client.get(f"/merchant/transactions?{query}", headers=merchant["headers"]).status_code == 422


def test_merchant_list_filters_sorts_and_isolation(client, merchant, ledger):
    h = merchant["headers"]
    got = ids(client.get("/merchant/transactions", headers=h))
    assert sorted(got) == ["FP-AAAAAAAA01", "FP-AAAAAAAA02", "FP-AAAAAAAA03", "FP-CCCCCCCC01"]  # never the other merchant's rows
    assert ids(client.get("/merchant/transactions?sort=amount_desc", headers=h))[0] == "FP-CCCCCCCC01"
    assert ids(client.get("/merchant/transactions?status=FAILED", headers=h)) == ["FP-AAAAAAAA03"]
    assert ids(client.get("/merchant/transactions?q=other person", headers=h)) == ["FP-CCCCCCCC01"]  # payer name
    assert ids(client.get("/merchant/transactions?q=SG-1", headers=h)) == ["FP-AAAAAAAA01"]
    assert ids(client.get("/merchant/transactions?q=CC-1", headers=h)) == []  # another merchant's order reference
    assert ids(client.get("/merchant/transactions?limit=2&offset=2&sort=oldest", headers=h)) == ["FP-AAAAAAAA03", "FP-CCCCCCCC01"]


# ------------------------------------------------------------ customer spending summary


def test_customer_summary_counts_only_successful_payments(client, customer, ledger):
    s = client.get("/payments/summary", headers=customer["headers"]).json()
    assert s["currency"] == "INR" and s["payments"] == 3
    assert Decimal(s["total_spent"]) == Decimal("390.50")  # 100 + 250.50 + 40; FAILED and PENDING excluded
    assert Decimal(s["spent_last_30_days"]) == Decimal("350.50")  # the 40.00 payment is 40 days old
    assert datetime.fromisoformat(s["last_payment_at"]) > datetime.now(UTC) - timedelta(days=2)


def test_customer_summary_is_private_and_handles_no_payments(client, customer, merchant):
    s = client.get("/payments/summary", headers=customer["headers"]).json()
    assert (s["payments"], Decimal(s["total_spent"]), s["last_payment_at"]) == (0, 0, None)
    assert client.get("/payments/summary").status_code == 401
    assert client.get("/payments/summary", headers=merchant["headers"]).status_code == 403


def test_other_customers_spending_never_leaks(client, ledger):
    other = ledger["other_cust"]
    s = client.get("/payments/summary", headers=other["headers"]).json()
    assert s["payments"] == 1 and Decimal(s["total_spent"]) == Decimal("999.00")
