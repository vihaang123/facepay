import os
import uuid

from dotenv import dotenv_values

# TEST_DATABASE_URL comes from the environment or backend/.env (git-ignored).
_env_file = os.path.join(os.path.dirname(__file__), "..", ".env")
_test_url = os.environ.get("TEST_DATABASE_URL") or dotenv_values(_env_file).get("TEST_DATABASE_URL")
if not _test_url:
    raise RuntimeError("Set TEST_DATABASE_URL (see backend/.env.example) to run the tests.")
# These tests downgrade the schema to base, so never run them on a non-test database.
if not _test_url.rsplit("/", 1)[-1].split("?")[0].endswith("_test"):
    raise RuntimeError("TEST_DATABASE_URL must point at a database whose name ends in '_test'.")

# Point the app at the test database BEFORE any app module is imported.
os.environ["DATABASE_URL"] = _test_url
os.environ.setdefault("JWT_SECRET", "test-secret-test-secret-1234567890")
# Off by default so tests don't trip over each other; the rate-limit tests turn it on.
os.environ["RATE_LIMIT_ENABLED"] = "false"

import pytest  # noqa: E402
from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.core.rate_limit import auth_limiter  # noqa: E402
from app.database.session import Base, SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402

STRONG_PASSWORD = "Correct-horse-42"


@pytest.fixture(scope="session", autouse=True)
def migrated_db():
    cfg = Config(os.path.join(os.path.dirname(__file__), "..", "alembic.ini"))
    command.downgrade(cfg, "base")
    command.upgrade(cfg, "head")
    yield
    engine.dispose()


@pytest.fixture(autouse=True)
def clean_tables(migrated_db):
    """Empty every table before each test (test database only, guarded above)."""
    names = ", ".join(t.name for t in Base.metadata.sorted_tables)
    with engine.begin() as conn:
        conn.execute(text(f"TRUNCATE TABLE {names} RESTART IDENTITY CASCADE"))
    auth_limiter.reset()
    yield


@pytest.fixture
def db():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


@pytest.fixture
def client():
    return TestClient(app)


def unique_email(prefix: str = "user") -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}@example.com"


@pytest.fixture
def customer(client):
    """Registers a customer and returns credentials plus a ready Authorization header."""
    email = unique_email("cust")
    r = client.post(
        "/auth/register",
        json={"name": "Test Customer", "email": email, "phone": "+919876543210", "password": STRONG_PASSWORD},
    )
    assert r.status_code == 201, r.text
    token = client.post("/auth/login", json={"email": email, "password": STRONG_PASSWORD}).json()
    return {
        "email": email,
        "password": STRONG_PASSWORD,
        "id": r.json()["id"],
        "headers": {"Authorization": f"Bearer {token['access_token']}"},
    }


@pytest.fixture
def merchant(client):
    email = unique_email("merch")
    r = client.post(
        "/auth/merchant/register",
        json={"name": "Test Owner", "business_name": "SuperGrocery", "email": email, "password": STRONG_PASSWORD},
    )
    assert r.status_code == 201, r.text
    token = client.post("/auth/merchant/login", json={"email": email, "password": STRONG_PASSWORD}).json()
    return {
        "email": email,
        "password": STRONG_PASSWORD,
        "id": r.json()["id"],
        "headers": {"Authorization": f"Bearer {token['access_token']}"},
    }
