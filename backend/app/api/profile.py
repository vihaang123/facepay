from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_current_customer, get_current_merchant
from app.database.session import get_db
from app.models import Merchant, User
from app.schemas.auth import MerchantOut, MerchantUpdate, UserOut, UserUpdate
from app.services import auth_service as svc

router = APIRouter(tags=["profile"])


@router.get("/users/me", response_model=UserOut)
def read_customer_profile(user: User = Depends(get_current_customer)):
    return user


@router.patch("/users/me", response_model=UserOut)
def update_customer_profile(
    data: UserUpdate,
    user: User = Depends(get_current_customer),
    db: Session = Depends(get_db),
):
    return svc.update_customer(db, user, data)


@router.get("/merchants/me", response_model=MerchantOut)
def read_merchant_profile(merchant: Merchant = Depends(get_current_merchant)):
    return merchant


@router.patch("/merchants/me", response_model=MerchantOut)
def update_merchant_profile(
    data: MerchantUpdate,
    merchant: Merchant = Depends(get_current_merchant),
    db: Session = Depends(get_db),
):
    return svc.update_merchant(db, merchant, data)
