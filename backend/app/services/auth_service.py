"""Registration, authentication and profile logic for customers and merchants.

Kept free of FastAPI types so Phase 3+ (face authentication, payments) can reuse
it: face login will resolve a User here and then issue the same kind of token.
"""

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.security import (
    hash_password,
    password_needs_rehash,
    verify_password,
)
from app.core.config import get_settings
from app.models import Merchant, User
from app.services import facepay_service, ledger_service
from app.schemas.auth import (
    CustomerRegister,
    MerchantRegister,
    MerchantUpdate,
    UserUpdate,
)


class EmailAlreadyRegistered(Exception):
    pass


class InvalidCredentials(Exception):
    pass


class AccountDisabled(Exception):
    pass


def register_customer(db: Session, data: CustomerRegister) -> User:
    """Creates the customer with a unique FacePay ID and the simulated opening balance, in one commit."""
    if db.scalar(select(User.id).where(User.email == data.email)) is not None:
        raise EmailAlreadyRegistered
    password_hash = hash_password(data.password)
    for _ in range(6):
        user = User(
            name=data.name,
            email=data.email,
            phone=data.phone,
            password_hash=password_hash,
            facepay_id=facepay_service.generate_unique(db, data.name),
        )
        db.add(user)
        try:
            db.flush()
            ledger_service.grant_opening_balance(db, user, get_settings().opening_balance)
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            if db.scalar(select(User.id).where(User.email == data.email)) is not None:  # lost a race with a concurrent signup
                raise EmailAlreadyRegistered from exc
            continue  # the generated FacePay ID was taken in the meantime: generate another
        db.refresh(user)
        return user
    raise RuntimeError("could not allocate a unique FacePay ID")


def register_merchant(db: Session, data: MerchantRegister) -> Merchant:
    if db.scalar(select(Merchant.id).where(Merchant.email == data.email)) is not None:
        raise EmailAlreadyRegistered
    merchant = Merchant(
        name=data.name,
        email=data.email,
        business_name=data.business_name,
        password_hash=hash_password(data.password),
    )
    db.add(merchant)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise EmailAlreadyRegistered from exc
    db.refresh(merchant)
    return merchant


def authenticate_customer(db: Session, email: str, password: str) -> User:
    user = db.scalar(select(User).where(User.email == email))
    # Always run a verification, even for unknown emails, to keep timing similar.
    ok = verify_password(password, user.password_hash if user else None)
    if user is None or not ok:
        raise InvalidCredentials
    if user.status != "active":
        raise AccountDisabled
    _upgrade_hash_if_needed(db, user, password)
    return user


def authenticate_merchant(db: Session, email: str, password: str) -> Merchant:
    merchant = db.scalar(select(Merchant).where(Merchant.email == email))
    ok = verify_password(password, merchant.password_hash if merchant else None)
    if merchant is None or not ok:
        raise InvalidCredentials
    _upgrade_hash_if_needed(db, merchant, password)
    return merchant


def _upgrade_hash_if_needed(db: Session, account: User | Merchant, password: str) -> None:
    if password_needs_rehash(account.password_hash):
        account.password_hash = hash_password(password)
        db.commit()


def update_customer(db: Session, user: User, data: UserUpdate) -> User:
    changes = data.model_dump(exclude_unset=True)
    if changes.get("name") is not None:
        user.name = changes["name"]
    if "phone" in changes:  # explicit null clears the phone number
        user.phone = changes["phone"]
    db.commit()
    db.refresh(user)
    return user


def update_merchant(db: Session, merchant: Merchant, data: MerchantUpdate) -> Merchant:
    changes = data.model_dump(exclude_unset=True)
    if changes.get("name") is not None:
        merchant.name = changes["name"]
    if changes.get("business_name") is not None:
        merchant.business_name = changes["business_name"]
    db.commit()
    db.refresh(merchant)
    return merchant
