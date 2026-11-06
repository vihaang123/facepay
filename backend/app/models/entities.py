from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Numeric,
    String,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.facepay_id import fallback_id
from app.database.session import Base


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("role IN ('customer', 'admin')", name="ck_users_role"),
        CheckConstraint("status IN ('active', 'disabled')", name="ck_users_status"),
        CheckConstraint("balance >= 0", name="ck_users_balance_non_negative"),
        CheckConstraint("facepay_id ~ '^[a-z0-9]+([._][a-z0-9]+)*@facepay$'", name="ck_users_facepay_id_format"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    email: Mapped[str | None] = mapped_column(String(255), unique=True, index=True)  # null for accounts made with a mobile number
    mobile: Mapped[str | None] = mapped_column(String(10))  # display copy; the mobile_numbers registry is the authority
    passcode_hash: Mapped[str | None] = mapped_column(String(255))  # the 6-digit app passcode (argon2), never the passcode itself
    # The customer's public payment handle (canonical `handle@facepay`, lowercase). Unique in the database.
    # The service generates a readable one at registration; the default only covers rows created without it.
    facepay_id: Mapped[str] = mapped_column(String(40), unique=True, index=True, default=fallback_id)
    facepay_id_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Simulated wallet balance. The backend is authoritative: it only changes inside a ledger posting (ledger_service).
    balance: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"), server_default="0")
    phone: Mapped[str | None] = mapped_column(String(20))
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(20), default="customer", server_default="customer")
    status: Mapped[str] = mapped_column(String(20), default="active", server_default="active")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # Security controls. Turning biometric payments off blocks face authentication for payments.
    biometric_payments_enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("true"))
    # The customer chose to be findable by a camera ("Let shops and friends find me by face"). Off until they switch it on.
    face_lookup_enabled: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"))
    # Optional payment PIN (argon2 hash), used as the second factor when a payment is higher risk.
    payment_pin_hash: Mapped[str | None] = mapped_column(String(255))
    pin_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    pin_failed_attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    pin_locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Deleting a user removes their face profiles (DB ON DELETE CASCADE does the work)
    # but keeps authentication logs, detached (ON DELETE SET NULL).
    face_profiles: Mapped[list["FaceProfile"]] = relationship(
        back_populates="user", cascade="all, delete-orphan", passive_deletes=True
    )
    authentication_logs: Mapped[list["AuthenticationLog"]] = relationship(
        back_populates="user", passive_deletes=True
    )
    transactions: Mapped[list["Transaction"]] = relationship(back_populates="payer", foreign_keys="Transaction.payer_id")


class Merchant(Base):
    __tablename__ = "merchants"
    __table_args__ = (CheckConstraint("balance >= 0", name="ck_merchants_balance_non_negative"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    email: Mapped[str | None] = mapped_column(String(255), unique=True, index=True)  # null for accounts made with a mobile number
    mobile: Mapped[str | None] = mapped_column(String(10))  # display copy; the mobile_numbers registry is the authority
    passcode_hash: Mapped[str | None] = mapped_column(String(255))  # the 6-digit app passcode (argon2), never the passcode itself
    business_name: Mapped[str] = mapped_column(String(160))
    password_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # Simulated settled balance: credited by merchant payments inside the same ledger posting that debits the customer.
    balance: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"), server_default="0")

    transactions: Mapped[list["Transaction"]] = relationship(back_populates="merchant")
    payment_sessions: Mapped[list["PaymentSession"]] = relationship(back_populates="merchant")


class FacePayIdHistory(Base):
    """A FacePay ID a customer used to have. It stays reserved for that customer so nobody else can take over a
    handle that others may still have saved or printed."""

    __tablename__ = "facepay_id_history"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    facepay_id: Mapped[str] = mapped_column(String(40), unique=True)
    retired_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ModelVersion(Base):
    __tablename__ = "model_versions"
    __table_args__ = (
        CheckConstraint("status IN ('training', 'active', 'retired', 'failed')", name="ck_model_versions_status"),
        # At most one deployed model at any time.
        Index("uq_model_versions_one_active", "status", unique=True, postgresql_where=text("status = 'active'")),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    version: Mapped[str] = mapped_column(String(40), unique=True)
    pca_config: Mapped[dict | None] = mapped_column(JSONB)
    lda_config: Mapped[dict | None] = mapped_column(JSONB)
    classifier: Mapped[str | None] = mapped_column(String(60))
    # Filled only from real evaluation runs, never hand-written.
    evaluation_metrics: Mapped[dict | None] = mapped_column(JSONB)
    trained_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    status: Mapped[str] = mapped_column(String(20), default="training", server_default="training")
    # AES-GCM encrypted joblib of the fitted PCA -> LDA -> classifier pipeline.
    artifact: Mapped[bytes | None] = mapped_column(LargeBinary)
    n_samples: Mapped[int | None] = mapped_column(Integer)
    n_classes: Mapped[int | None] = mapped_column(Integer)
    # SHA-256 over the (user, sample) ids used for training: tells whether the data has changed since.
    dataset_fingerprint: Mapped[str | None] = mapped_column(String(64))
    library_versions: Mapped[dict | None] = mapped_column(JSONB)


class FaceProfile(Base):
    __tablename__ = "face_profiles"
    __table_args__ = (
        CheckConstraint("status IN ('active', 'revoked')", name="ck_face_profiles_status"),
        Index("ix_face_profiles_user_status", "user_id", "status"),
        # One live profile per user.
        Index("uq_face_profiles_one_active", "user_id", unique=True, postgresql_where=text("status = 'active'")),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    model_version_id: Mapped[int | None] = mapped_column(ForeignKey("model_versions.id"))
    # Processed feature representation only; raw images are not stored.
    feature_data: Mapped[bytes | None] = mapped_column(LargeBinary)
    sample_count: Mapped[int] = mapped_column(default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    status: Mapped[str] = mapped_column(String(20), default="active", server_default="active")

    user: Mapped[User] = relationship(back_populates="face_profiles")


class FaceSample(Base):
    """One enrolled face crop: 64x64 equalised grayscale, AES-GCM encrypted. Never the raw frame."""

    __tablename__ = "face_samples"
    __table_args__ = (Index("ix_face_samples_user_pose", "user_id", "pose"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    pose: Mapped[str] = mapped_column(String(20))
    crop_encrypted: Mapped[bytes] = mapped_column(LargeBinary)
    # The deep-embedding engine's 128 numbers for this sample (AES-GCM encrypted). NULL for samples taken before that engine was on.
    embedding_encrypted: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    sharpness: Mapped[float] = mapped_column()
    brightness: Mapped[float] = mapped_column()
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class FaceAuthChallenge(Base):
    """A single-use liveness challenge issued to one customer (expires after CHALLENGE_TTL_SECONDS)."""

    __tablename__ = "face_auth_challenges"
    __table_args__ = (Index("ix_face_auth_challenges_user", "user_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    token: Mapped[str] = mapped_column(String(64), unique=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    challenge: Mapped[str] = mapped_column(String(20))
    issued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PaymentSession(Base):
    """A payment waiting to be authorized and confirmed (simulated payments only). Two kinds:

    MERCHANT  a bill created by a merchant; any signed-in customer may pay it.
    TRANSFER  a customer-to-customer payment prepared by ONE payer (payer_user_id) for ONE recipient (payee_user_id),
              either sent directly or in answer to a money request. Nobody else can open, authenticate or confirm it.

    Lifecycle: CREATED -> AUTHENTICATED -> PAID, or CREATED/AUTHENTICATED -> FAILED | EXPIRED | CANCELLED.
    (The brief's PENDING is stored as CREATED and SUCCESS as PAID; PROCESSING is the instant inside the single
    database transaction that consumes the authorization and writes the transaction, so it is not stored.)"""

    __tablename__ = "payment_sessions"
    __table_args__ = (
        CheckConstraint("amount > 0", name="ck_payment_sessions_amount_positive"),
        CheckConstraint(
            "status IN ('CREATED', 'AUTHENTICATED', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED')",
            name="ck_payment_sessions_status",
        ),
        CheckConstraint(
            "(kind = 'MERCHANT' AND merchant_id IS NOT NULL AND payee_user_id IS NULL AND payment_request_id IS NULL)"
            " OR (kind = 'TRANSFER' AND merchant_id IS NULL AND payee_user_id IS NOT NULL AND payer_user_id IS NOT NULL"
            " AND payee_user_id <> payer_user_id)",
            name="ck_payment_sessions_shape",
        ),
        Index("ix_payment_sessions_merchant_created", "merchant_id", "created_at"),
        Index("ix_payment_sessions_payer", "payer_user_id", "created_at"),
        # One open payment per money request, and one session per (payer, idempotency key).
        Index(
            "uq_payment_sessions_one_open_per_request",
            "payment_request_id",
            unique=True,
            postgresql_where=text("payment_request_id IS NOT NULL AND status IN ('CREATED', 'AUTHENTICATED')"),
        ),
        Index(
            "uq_payment_sessions_idempotency",
            "payer_user_id",
            "idempotency_key",
            unique=True,
            postgresql_where=text("idempotency_key IS NOT NULL"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    kind: Mapped[str] = mapped_column(String(20), default="MERCHANT", server_default="MERCHANT")
    merchant_id: Mapped[int | None] = mapped_column(ForeignKey("merchants.id"))
    payer_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    payee_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    payment_request_id: Mapped[int | None] = mapped_column(ForeignKey("payment_requests.id"))
    idempotency_key: Mapped[str | None] = mapped_column(String(64))
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    currency: Mapped[str] = mapped_column(String(3), default="INR", server_default="INR")
    order_reference: Mapped[str | None] = mapped_column(String(80))
    description: Mapped[str | None] = mapped_column(String(255))  # for a TRANSFER this is the payer's note
    purpose: Mapped[str | None] = mapped_column(String(24))  # category from app.core.purposes (merchant requests made by face)
    status: Mapped[str] = mapped_column(String(20), default="CREATED", server_default="CREATED")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Rejected face-authentication attempts that counted against this session (see payment_service).
    failed_auth_attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # The merchant chose to display this request in the simulated "nearby" list (a demo of discovery; no location is used).
    discoverable: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"))

    merchant: Mapped[Merchant | None] = relationship(back_populates="payment_sessions")
    transactions: Mapped[list["Transaction"]] = relationship(back_populates="payment_session")


class Transaction(Base):
    __tablename__ = "transactions"
    __table_args__ = (
        CheckConstraint("amount > 0", name="ck_transactions_amount_positive"),
        CheckConstraint("status IN ('PENDING', 'SUCCESS', 'FAILED')", name="ck_transactions_status"),
        # A merchant payment has a merchant and no recipient; a transfer has a recipient (never the payer) and no merchant.
        CheckConstraint(
            "(kind = 'MERCHANT_PAYMENT' AND merchant_id IS NOT NULL AND recipient_id IS NULL)"
            " OR (kind = 'TRANSFER' AND merchant_id IS NULL AND recipient_id IS NOT NULL AND recipient_id <> payer_id)",
            name="ck_transactions_shape",
        ),
        Index("ix_transactions_merchant_ts", "merchant_id", "timestamp"),
        Index("ix_transactions_payer_ts", "payer_id", "timestamp"),
        Index("ix_transactions_recipient_ts", "recipient_id", "timestamp"),
        # A payment session can be paid once, even if application logic were bypassed.
        Index(
            "uq_transactions_one_success_per_session",
            "payment_session_id",
            unique=True,
            postgresql_where=text("status = 'SUCCESS' AND payment_session_id IS NOT NULL"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    transaction_id: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    kind: Mapped[str] = mapped_column(String(20), default="MERCHANT_PAYMENT", server_default="MERCHANT_PAYMENT")
    payer_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    merchant_id: Mapped[int | None] = mapped_column(ForeignKey("merchants.id"))
    recipient_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    payment_session_id: Mapped[int | None] = mapped_column(
        ForeignKey("payment_sessions.id", name="fk_transactions_payment_session"), index=True
    )
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    currency: Mapped[str] = mapped_column(String(3), default="INR", server_default="INR")
    note: Mapped[str | None] = mapped_column(String(255))
    payment_method: Mapped[str] = mapped_column(String(20), default="FACE_PAY", server_default="FACE_PAY")
    status: Mapped[str] = mapped_column(String(20), default="PENDING", server_default="PENDING")
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # The simulated bank account this payment was made from. Name and reference are copied so the receipt stays correct
    # if the account is disconnected later. Only the payer ever sees them.
    funding_source_id: Mapped[int | None] = mapped_column(ForeignKey("bank_connections.id", name="fk_transactions_funding_source"))
    funding_bank_name: Mapped[str | None] = mapped_column(String(80))
    funding_account_ref: Mapped[str | None] = mapped_column(String(24))
    # UPI-style reference: 12 random digits, unique. Nullable only so a row written by an older server mid-deploy is still valid.
    utr: Mapped[str | None] = mapped_column(String(12), unique=True, index=True)
    failure_code: Mapped[str | None] = mapped_column(String(30))  # why a FAILED transaction failed (BANK_DECLINED, BANK_TIMEOUT)

    merchant: Mapped[Merchant | None] = relationship(back_populates="transactions")
    payer: Mapped[User] = relationship(back_populates="transactions", foreign_keys=[payer_id])
    payment_session: Mapped[PaymentSession | None] = relationship(back_populates="transactions")


class PaymentAuthorization(Base):
    """Single-use, short-lived proof that THIS customer passed face authentication for THIS payment session.

    Issued only by the backend after the Phase 4 decision is AUTHENTICATED. The bearer token is returned once;
    only its SHA-256 is stored. Holds no biometric data, just a reference to the authentication log row."""

    __tablename__ = "payment_authorizations"
    __table_args__ = (
        CheckConstraint("status IN ('ACTIVE', 'CONSUMED', 'EXPIRED', 'REVOKED')", name="ck_payment_authorizations_status"),
        Index("ix_payment_authorizations_session", "payment_session_id"),
        Index(
            "uq_payment_authorizations_one_active",
            "payment_session_id",
            "user_id",
            unique=True,
            postgresql_where=text("status = 'ACTIVE'"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    payment_session_id: Mapped[int] = mapped_column(ForeignKey("payment_sessions.id", ondelete="CASCADE"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    authentication_log_id: Mapped[int | None] = mapped_column(ForeignKey("authentication_logs.id", ondelete="SET NULL"))
    # What this authorization was issued for, copied from the session at issue time and re-checked at confirmation.
    # Nothing biometric is stored here.
    merchant_id: Mapped[int | None] = mapped_column(ForeignKey("merchants.id"))
    payee_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))  # recipient of a TRANSFER
    amount: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    currency: Mapped[str | None] = mapped_column(String(3))
    order_reference: Mapped[str | None] = mapped_column(String(80))
    model_version: Mapped[str | None] = mapped_column(String(40))
    # Risk-based step-up (prototype): when required, confirmation also needs the customer's payment PIN.
    step_up_required: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"))
    step_up_reasons: Mapped[str | None] = mapped_column(String(160))
    step_up_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(20), default="ACTIVE", server_default="ACTIVE")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AuthenticationLog(Base):
    __tablename__ = "authentication_logs"
    __table_args__ = (
        CheckConstraint("result IN ('SUCCESS', 'FAILED')", name="ck_auth_logs_result"),
        Index("ix_auth_logs_user_ts", "user_id", "timestamp"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    result: Mapped[str] = mapped_column(String(20))
    confidence: Mapped[float | None]
    liveness_result: Mapped[str | None] = mapped_column(String(20))  # PASSED | FAILED | NOT_EVALUATED
    # Phase 4. Metadata only: no images, crops or feature vectors are ever logged.
    failure_reason: Mapped[str | None] = mapped_column(String(40))  # machine-readable, e.g. LIVENESS_FAILED
    failure_detail: Mapped[str | None] = mapped_column(String(40))  # e.g. NO_MOVEMENT, TOO_BLURRY
    distance: Mapped[float | None]
    challenge: Mapped[str | None] = mapped_column(String(20))
    model_version: Mapped[str | None] = mapped_column(String(40))
    # References only (never images): the payment session this attempt was for and, if it led to one, the transaction.
    payment_session_ref: Mapped[str | None] = mapped_column(String(40))
    transaction_ref: Mapped[str | None] = mapped_column(String(40))
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    user: Mapped[User | None] = relationship(back_populates="authentication_logs")


class SecurityEvent(Base):
    """Audit trail of security-relevant account actions (PIN set or failed, biometric toggled, face data removed,
    payment limits hit). Metadata only: no images, vectors, PINs or tokens."""

    __tablename__ = "security_events"
    __table_args__ = (Index("ix_security_events_user_ts", "user_id", "created_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    kind: Mapped[str] = mapped_column(String(40))
    session_ref: Mapped[str | None] = mapped_column(String(40))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class PaymentRequest(Base):
    """A request for money from one customer to another. Creating it moves nothing: the payer must open it, review it
    and authorize the payment themselves. Lifecycle: PENDING -> PAID | DECLINED | CANCELLED | EXPIRED (all final)."""

    __tablename__ = "payment_requests"
    __table_args__ = (
        CheckConstraint("amount > 0", name="ck_payment_requests_amount_positive"),
        CheckConstraint("requester_id <> payer_id", name="ck_payment_requests_not_self"),
        CheckConstraint(
            "status IN ('PENDING', 'PAID', 'DECLINED', 'CANCELLED', 'EXPIRED')", name="ck_payment_requests_status"
        ),
        Index("ix_payment_requests_payer_status", "payer_id", "status"),
        Index("ix_payment_requests_requester_created", "requester_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    request_id: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    requester_id: Mapped[int] = mapped_column(ForeignKey("users.id"))  # who gets the money
    payer_id: Mapped[int] = mapped_column(ForeignKey("users.id"))  # who is asked to pay
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    currency: Mapped[str] = mapped_column(String(3), default="INR", server_default="INR")
    note: Mapped[str | None] = mapped_column(String(255))  # the reference: what the money is for (required for new requests)
    purpose: Mapped[str | None] = mapped_column(String(24))  # category from app.core.purposes
    source: Mapped[str | None] = mapped_column(String(16))  # ID (FacePay ID typed or scanned) | FACE (found by face)
    status: Mapped[str] = mapped_column(String(20), default="PENDING", server_default="PENDING")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    transaction_id: Mapped[int | None] = mapped_column(
        ForeignKey("transactions.id", use_alter=True, name="fk_payment_requests_transaction")  # breaks the table-creation cycle
    )


class FaceLookup(Base):
    """A single-use ticket: "this requester found this customer by face". Lets the requester send ONE request without
    learning the customer's FacePay ID. Only a hash of the ticket is stored. Exactly one of the two requester columns is set."""

    __tablename__ = "face_lookups"
    __table_args__ = (
        CheckConstraint(
            "(requester_user_id IS NOT NULL AND requester_merchant_id IS NULL)"
            " OR (requester_user_id IS NULL AND requester_merchant_id IS NOT NULL)",
            name="ck_face_lookups_one_requester",
        ),
        Index("ix_face_lookups_target", "target_user_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    requester_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    requester_merchant_id: Mapped[int | None] = mapped_column(ForeignKey("merchants.id", ondelete="CASCADE"))
    target_user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class BankConnection(Base):
    """A SIMULATED bank connection: the funding source a customer picks when paying. It is a record and nothing more:
    no credentials, no real account number, no balance, and nothing is ever sent to a bank. The reference shown to the
    customer is DEMO-••••-<last4>, which cannot be mistaken for a real account number."""

    __tablename__ = "bank_connections"
    __table_args__ = (
        CheckConstraint("status IN ('CONNECTED', 'DISCONNECTED')", name="ck_bank_connections_status"),
        CheckConstraint("account_type IN ('SAVINGS', 'SALARY', 'CURRENT')", name="ck_bank_connections_type"),
        CheckConstraint("account_last4 ~ '^[0-9]{4}$'", name="ck_bank_connections_last4"),
        CheckConstraint("NOT is_default OR status = 'CONNECTED'", name="ck_bank_connections_default_connected"),
        CheckConstraint("sim_behavior IN ('NORMAL', 'DECLINE', 'TIMEOUT')", name="ck_bank_connections_behavior"),
        Index("ix_bank_connections_user_status", "user_id", "status"),
        # One default per customer, and one live connection per (customer, bank, account type).
        Index("uq_bank_connections_one_default", "user_id", unique=True, postgresql_where=text("is_default AND status = 'CONNECTED'")),
        Index(
            "uq_bank_connections_live_account", "user_id", "bank_code", "account_type", unique=True,
            postgresql_where=text("status = 'CONNECTED'"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    connection_id: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    bank_code: Mapped[str] = mapped_column(String(24))
    bank_name: Mapped[str] = mapped_column(String(80))
    account_type: Mapped[str] = mapped_column(String(20))
    account_last4: Mapped[str] = mapped_column(String(4))
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"))
    status: Mapped[str] = mapped_column(String(16), default="CONNECTED", server_default="CONNECTED")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    disconnected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # DEMO switch chosen by the owner: how this simulated account answers a payment (see app/core/upi.py). Not random.
    sim_behavior: Mapped[str] = mapped_column(String(12), default="NORMAL", server_default="NORMAL")

    @property
    def account_ref(self) -> str:
        return f"DEMO-••••-{self.account_last4}"


class LedgerEntry(Base):
    """One side of a simulated money movement. Every transfer or merchant payment writes a DEBIT and a CREDIT of the
    same amount in the same database transaction; an OPENING_GRANT is a single CREDIT from the simulation itself.
    An account's balance always equals its credits minus its debits (checked by ledger_service.reconcile)."""

    __tablename__ = "ledger_entries"
    __table_args__ = (
        CheckConstraint("amount > 0", name="ck_ledger_entries_amount_positive"),
        CheckConstraint("account_type IN ('USER', 'MERCHANT')", name="ck_ledger_entries_account_type"),
        CheckConstraint("direction IN ('DEBIT', 'CREDIT')", name="ck_ledger_entries_direction"),
        CheckConstraint("kind IN ('TRANSFER', 'MERCHANT_PAYMENT', 'OPENING_GRANT')", name="ck_ledger_entries_kind"),
        Index("ix_ledger_entries_account", "account_type", "account_id", "id"),
        Index("ix_ledger_entries_transaction", "transaction_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    transaction_id: Mapped[int | None] = mapped_column(ForeignKey("transactions.id"))
    account_type: Mapped[str] = mapped_column(String(10))
    account_id: Mapped[int] = mapped_column(Integer)
    direction: Mapped[str] = mapped_column(String(6))
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    balance_after: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    kind: Mapped[str] = mapped_column(String(20))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class MobileNumber(Base):
    """Who owns a mobile number. The primary key makes "one number, one account" true across customers, merchants and
    the admin even when two sign-ups race, and it is how number sign-in finds the account. Digits only, 10 of them."""

    __tablename__ = "mobile_numbers"
    __table_args__ = (
        CheckConstraint("account_type IN ('user', 'merchant')", name="ck_mobile_numbers_type"),
        CheckConstraint(
            "(account_type = 'user' AND user_id IS NOT NULL AND merchant_id IS NULL)"
            " OR (account_type = 'merchant' AND merchant_id IS NOT NULL AND user_id IS NULL)",
            name="ck_mobile_numbers_one_owner",
        ),
        CheckConstraint("mobile ~ '^[6-9][0-9]{9}$'", name="ck_mobile_numbers_format"),
        Index("uq_mobile_numbers_user", "user_id", unique=True, postgresql_where=text("user_id IS NOT NULL")),
        Index("uq_mobile_numbers_merchant", "merchant_id", unique=True, postgresql_where=text("merchant_id IS NOT NULL")),
    )

    mobile: Mapped[str] = mapped_column(String(10), primary_key=True)
    account_type: Mapped[str] = mapped_column(String(10))
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    merchant_id: Mapped[int | None] = mapped_column(ForeignKey("merchants.id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class OtpChallenge(Base):
    """A DEMO one-time code. FacePay cannot send SMS, so the code is shown on screen and labelled as a demo; it proves nothing
    about who holds the SIM. Short-lived, limited tries, single use, and only a keyed hash of the code is stored."""

    __tablename__ = "otp_challenges"
    __table_args__ = (Index("ix_otp_challenges_mobile", "mobile", "created_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    challenge_id: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    mobile: Mapped[str] = mapped_column(String(10))
    code_hash: Mapped[str] = mapped_column(String(64))
    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class SigninAttempt(Base):
    """Failed passcode tries per mobile number (known or not, so a lock reveals nothing about which numbers exist)."""

    __tablename__ = "signin_attempts"

    mobile: Mapped[str] = mapped_column(String(10), primary_key=True)
    failed_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
