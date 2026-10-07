import os

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

import pytest  # noqa: E402
from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.database.session import SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def migrated_db():
    cfg = Config(os.path.join(os.path.dirname(__file__), "..", "alembic.ini"))
    command.downgrade(cfg, "base")
    command.upgrade(cfg, "head")
    yield
    engine.dispose()


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
