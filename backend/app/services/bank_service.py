"""Simulated bank connections: the funding sources a customer chooses when paying.

Nothing here talks to a bank, asks for a credential or knows a balance. A connection is a row that says "this customer
picked this bank and this kind of demo account". Every query is scoped to the signed-in customer, and another customer's
connection is indistinguishable from one that does not exist.
"""

import secrets
from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core import banks
from app.models import BankConnection, User
from app.services import security_service as sec


def _err(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code, detail={"code": code, "message": message})


def out(c: BankConnection) -> dict:
    return {
        "connection_id": c.connection_id,
        "bank_code": c.bank_code,
        "bank_name": c.bank_name,
        "account_type": c.account_type,
        "account_type_label": banks.ACCOUNT_TYPES.get(c.account_type, c.account_type),
        "account_ref": c.account_ref,
        "is_default": c.is_default,
        "status": c.status,
        "connected_at": c.created_at,
        "disclaimer": banks.DEMO_DISCLAIMER,
    }


def catalog() -> dict:
    return {
        "banks": banks.catalog(),
        "account_types": [{"code": k, "label": v} for k, v in banks.ACCOUNT_TYPES.items()],
        "max_connected": banks.MAX_CONNECTED_BANKS,
        "disclaimer": banks.DEMO_DISCLAIMER,
    }


def connected(db: Session, user: User) -> list[BankConnection]:
    """The customer's live connections, default first."""
    return list(
        db.scalars(
            select(BankConnection)
            .where(BankConnection.user_id == user.id, BankConnection.status == "CONNECTED")
            .order_by(BankConnection.is_default.desc(), BankConnection.id)
        )
    )


def listing(db: Session, user: User) -> list[dict]:
    return [out(c) for c in connected(db, user)]


def _lock_user(db: Session, user: User) -> None:
    """Serialises this customer's connection changes, so two taps cannot leave two defaults or exceed the limit."""
    db.execute(select(User.id).where(User.id == user.id).with_for_update())


def _owned(db: Session, user: User, connection_id: str, *, lock: bool = False) -> BankConnection:
    q = select(BankConnection).where(
        BankConnection.connection_id == connection_id, BankConnection.user_id == user.id, BankConnection.status == "CONNECTED"
    )
    if lock:
        q = q.with_for_update().execution_options(populate_existing=True)
    c = db.scalar(q)
    if c is None:
        raise _err(404, "BANK_NOT_FOUND", "That bank connection does not exist.")
    return c


def connect(db: Session, user: User, *, bank_code: str, account_type: str) -> dict:
    bank = banks.BANKS.get(bank_code)
    if bank is None:
        raise _err(422, "BANK_UNKNOWN", "Choose a bank from the list.")
    if account_type not in banks.ACCOUNT_TYPES:
        raise _err(422, "ACCOUNT_TYPE_UNKNOWN", "Choose one of the demo account types.")
    _lock_user(db, user)
    live = connected(db, user)
    if len(live) >= banks.MAX_CONNECTED_BANKS:
        raise _err(409, "BANK_LIMIT", f"You can connect up to {banks.MAX_CONNECTED_BANKS} demo accounts. Disconnect one first.")
    if any(c.bank_code == bank_code and c.account_type == account_type for c in live):
        raise _err(409, "BANK_ALREADY_CONNECTED", f"Your {banks.ACCOUNT_TYPES[account_type].lower()} at {bank['name']} is already connected.")
    c = BankConnection(
        connection_id="bk_" + secrets.token_urlsafe(14),
        user_id=user.id,
        bank_code=bank_code,
        bank_name=bank["name"],  # from the server's catalog, never from the client
        account_type=account_type,
        account_last4="".join(secrets.choice("0123456789") for _ in range(4)),
        is_default=not live,  # the first one connected becomes the default
        status="CONNECTED",
    )
    db.add(c)
    sec.record_event(db, user, "BANK_CONNECTED", c.connection_id)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise _err(409, "BANK_ALREADY_CONNECTED", "That account is already connected.") from None
    db.refresh(c)
    return out(c)


def set_default(db: Session, user: User, connection_id: str) -> dict:
    _lock_user(db, user)
    target = _owned(db, user, connection_id, lock=True)
    for c in connected(db, user):
        if c.is_default and c.id != target.id:
            c.is_default = False
    db.flush()  # the unique index allows one default: release the old one before taking the new one
    target.is_default = True
    sec.record_event(db, user, "BANK_DEFAULT_CHANGED", target.connection_id)
    db.commit()
    db.refresh(target)
    return out(target)


def disconnect(db: Session, user: User, connection_id: str) -> dict:
    _lock_user(db, user)
    target = _owned(db, user, connection_id, lock=True)
    was_default = target.is_default
    target.status, target.is_default, target.disconnected_at = "DISCONNECTED", False, datetime.now(UTC)
    db.flush()
    if was_default:  # keep a default whenever any account remains
        remaining = connected(db, user)
        if remaining:
            remaining[0].is_default = True
    sec.record_event(db, user, "BANK_DISCONNECTED", target.connection_id)
    db.commit()
    return {"connection_id": connection_id, "status": "DISCONNECTED"}


def for_payment(db: Session, user: User, connection_id: str | None) -> BankConnection:
    """The funding source for a payment being confirmed, row-locked so it cannot be disconnected mid-payment.
    An explicit choice must be one of the customer's own live connections (anything else, including another customer's
    connection, is the same error); without one the default is used."""
    if connection_id:
        try:
            return _owned(db, user, connection_id, lock=True)
        except HTTPException:
            raise _err(409, "FUNDING_SOURCE_INVALID", "That bank account is not available. Choose another one.") from None
    default = db.scalar(
        select(BankConnection)
        .where(BankConnection.user_id == user.id, BankConnection.status == "CONNECTED", BankConnection.is_default)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if default is None:
        raise _err(409, "NO_FUNDING_SOURCE", "Connect a demo bank account to pay from before you confirm.")
    return default
