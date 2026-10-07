from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.database.session import get_db

router = APIRouter(tags=["health"])


@router.get("/health")
def health(db: Session = Depends(get_db)) -> dict:
    """Liveness plus a real database round trip."""
    try:
        db.execute(text("SELECT 1"))
        db_status = "ok"
    except SQLAlchemyError:
        db_status = "unreachable"
    return {
        "status": "ok" if db_status == "ok" else "degraded",
        "database": db_status,
        "service": "facepay-api",
        "note": "Academic prototype. Payments are simulated; no real money moves.",
    }
