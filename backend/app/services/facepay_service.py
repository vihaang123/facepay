"""FacePay IDs: generation, rename, lookup, contacts and QR resolution. All identity decisions are made here, on the
server, from normalised input. The client's copy of an ID is only ever a request to look something up."""

import re
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core import facepay_id as fid
from app.core.config import get_settings
from app.models import FacePayIdHistory, PaymentRequest, Transaction, User
from app.services import security_service as sec

QR_SCHEME = "facepay://"
_QR_RE = re.compile(r"^facepay://(pay|request)/([A-Za-z0-9._@\-]{3,60})$")


def _err(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code, detail={"code": code, "message": message})


def now() -> datetime:
    return datetime.now(UTC)


# ------------------------------------------------------------------ generation and rename


def is_taken(db: Session, facepay_id: str, *, for_user_id: int | None = None) -> bool:
    """True if another customer holds this ID now or held it before (retired IDs stay reserved for their owner)."""
    current = db.scalar(select(User.id).where(User.facepay_id == facepay_id))
    if current is not None and current != for_user_id:
        return True
    old_owner = db.scalar(select(FacePayIdHistory.user_id).where(FacePayIdHistory.facepay_id == facepay_id))
    return old_owner is not None and old_owner != for_user_id


def generate_unique(db: Session, name: str) -> str:
    """A readable ID from the first word of the name ('Vihaan Gandhi' -> vihaan@facepay); a number is appended when
    that is taken. The unique index is the real guarantee: the caller retries if a concurrent signup wins the race."""
    stem = fid.slug_from_name(name)
    usable = len(stem) >= fid.MIN_HANDLE and stem not in fid.RESERVED
    base = stem if usable else "user"
    candidate = base + fid.SUFFIX
    attempt = 0
    while not usable or is_taken(db, candidate):
        usable = True
        attempt += 1
        candidate = base + fid.random_digits(min(2 + attempt // 3, 6)) + fid.SUFFIX
        if attempt > 30:
            candidate = fid.fallback_id()
    return candidate


def change_id(db: Session, user: User, raw: str) -> User:
    """Rename. One change per cooldown period, never to an ID that belongs to (or once belonged to) someone else."""
    try:
        new = fid.normalize(raw)
    except fid.InvalidFacePayId as exc:
        raise _err(422, "FACEPAY_ID_INVALID", str(exc)) from None
    if new == user.facepay_id:
        raise _err(409, "FACEPAY_ID_UNCHANGED", "That is already your FacePay ID.")
    cooldown = timedelta(days=get_settings().facepay_id_change_cooldown_days)
    if user.facepay_id_changed_at is not None and user.facepay_id_changed_at + cooldown > now():
        until = (user.facepay_id_changed_at + cooldown).date().isoformat()
        raise _err(429, "FACEPAY_ID_COOLDOWN", f"You can change your FacePay ID again on {until}.")
    if is_taken(db, new, for_user_id=user.id):
        raise _err(409, "FACEPAY_ID_TAKEN", "That FacePay ID is not available. Please choose another.")
    old = user.facepay_id
    # Reverting to one of your own earlier IDs: it leaves the history table so the unique index stays truthful.
    mine = db.scalar(select(FacePayIdHistory).where(FacePayIdHistory.facepay_id == new, FacePayIdHistory.user_id == user.id))
    if mine is not None:
        db.delete(mine)
        db.flush()
    db.add(FacePayIdHistory(user_id=user.id, facepay_id=old))
    user.facepay_id = new
    user.facepay_id_changed_at = now()
    sec.record_event(db, user, "FACEPAY_ID_CHANGED")
    try:
        db.commit()
    except IntegrityError:  # lost a race for the same ID
        db.rollback()
        raise _err(409, "FACEPAY_ID_TAKEN", "That FacePay ID is not available. Please choose another.") from None
    db.refresh(user)
    return user


def qr_payload(facepay_id: str) -> str:
    return f"{QR_SCHEME}pay/{facepay_id}"


def profile(user: User) -> dict:
    cooldown = timedelta(days=get_settings().facepay_id_change_cooldown_days)
    next_change = user.facepay_id_changed_at + cooldown if user.facepay_id_changed_at else None
    return {
        "facepay_id": user.facepay_id,
        "masked_id": fid.mask(user.facepay_id),
        "display_name": user.name,
        "qr_payload": qr_payload(user.facepay_id),
        "can_change": next_change is None or next_change <= now(),
        "next_change_at": next_change if next_change and next_change > now() else None,
    }


# ------------------------------------------------------------------ lookup


def find_active(db: Session, raw: str) -> User | None:
    """The active customer with this ID, or None. Invalid input is 'not found', never a different error, so the
    response does not reveal anything about which strings are close to real IDs."""
    try:
        canonical = fid.normalize(raw)
    except fid.InvalidFacePayId:
        return None
    return db.scalar(select(User).where(User.facepay_id == canonical, User.status == "active"))


def resolve(db: Session, viewer: User, raw: str) -> dict:
    """What the payer needs to confirm the recipient: a name and a masked ID. Nothing else."""
    target = find_active(db, raw)
    if target is None:
        raise _err(404, "RECIPIENT_NOT_FOUND", "No FacePay account matches that ID. Check it and try again.")
    return {"display_name": target.name, "masked_id": fid.mask(target.facepay_id), "is_self": target.id == viewer.id}


# ------------------------------------------------------------------ QR


def parse_qr(payload: str) -> tuple[str, str]:
    """('pay', facepay_id) or ('request', request_ref). A bare FacePay ID is accepted too (manual entry fallback).
    Anything else is refused: a QR code is untrusted input."""
    text = (payload or "").strip()
    if not text or len(text) > 200:
        raise _err(422, "QR_INVALID", "That is not a FacePay QR code.")
    m = _QR_RE.match(text)
    if m:
        kind, value = m.groups()
        if kind == "pay":
            try:
                return "pay", fid.normalize(value)
            except fid.InvalidFacePayId:
                raise _err(422, "QR_INVALID", "That is not a FacePay QR code.") from None
        return "request", value
    try:
        return "pay", fid.normalize(text)
    except fid.InvalidFacePayId:
        raise _err(422, "QR_INVALID", "That is not a FacePay QR code.") from None


def resolve_qr(db: Session, viewer: User, payload: str) -> dict:
    """Resolves a scanned code through the database. Scanning proves nothing about identity or authorization: the
    caller still goes through review, face verification and confirmation."""
    from app.services import request_service  # local import: request_service uses this module

    kind, value = parse_qr(payload)
    if kind == "pay":
        target = resolve(db, viewer, value)
        return {"type": "PAY", "facepay_id": value, "recipient": target, "request": None}
    return {"type": "REQUEST", "facepay_id": None, "recipient": None, "request": request_service.view(db, viewer, value)}


# ------------------------------------------------------------------ contacts


def contacts(db: Session, user: User, limit: int = 12) -> list[dict]:
    """People this customer has actually dealt with (paid, been paid by, or exchanged a money request with), most
    recent first. Derived from real records; nothing is stored separately and nobody is added without an interaction."""
    seen: dict[int, datetime] = {}

    def note(other_id: int | None, when: datetime) -> None:
        if other_id is not None and (other_id not in seen or when > seen[other_id]):
            seen[other_id] = when

    for payer, recipient, ts in db.execute(
        select(Transaction.payer_id, Transaction.recipient_id, Transaction.timestamp)
        .where(Transaction.kind == "TRANSFER", Transaction.status == "SUCCESS", or_(Transaction.payer_id == user.id, Transaction.recipient_id == user.id))
        .order_by(Transaction.id.desc())
        .limit(200)
    ):
        note(recipient if payer == user.id else payer, ts)
    for requester, payer, ts in db.execute(
        select(PaymentRequest.requester_id, PaymentRequest.payer_id, PaymentRequest.created_at)
        .where(or_(PaymentRequest.requester_id == user.id, PaymentRequest.payer_id == user.id))
        .order_by(PaymentRequest.id.desc())
        .limit(200)
    ):
        note(payer if requester == user.id else requester, ts)
    if not seen:
        return []
    people = {u.id: u for u in db.scalars(select(User).where(User.id.in_(seen), User.status == "active"))}
    ordered = sorted((i for i in seen if i in people), key=lambda i: seen[i], reverse=True)[:limit]
    return [
        {"display_name": people[i].name, "facepay_id": people[i].facepay_id, "masked_id": fid.mask(people[i].facepay_id), "last_activity_at": seen[i]}
        for i in ordered
    ]
