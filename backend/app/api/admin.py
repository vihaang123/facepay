"""Administrator-only ML Lab. Every route depends on get_current_admin, which checks the role in the token and in the
database. A customer or merchant account, however valid, is refused with 403."""

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.deps import get_current_admin
from app.database.session import get_db
from app.schemas.transfers import AdminPayload
from app.services import admin_service

router = APIRouter(prefix="/admin/ml", tags=["admin"], dependencies=[Depends(get_current_admin)])


@router.get("/overview", response_model=AdminPayload)
def overview(db: Session = Depends(get_db)):
    return admin_service.overview(db)


@router.get("/analysis", response_model=AdminPayload)
def analysis(db: Session = Depends(get_db)):
    return admin_service.analysis(db)


@router.get("/benchmark", response_model=AdminPayload)
def benchmark():
    return admin_service.benchmark()


@router.get("/outcomes", response_model=AdminPayload)
def outcomes(days: int = Query(30, ge=1, le=365), db: Session = Depends(get_db)):
    return admin_service.outcomes(db, days)
