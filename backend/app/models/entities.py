from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
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

from app.database.session import Base


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("role IN ('customer', 'admin')", name="ck_users_role"),
        CheckConstraint("status IN ('active', 'disabled')", name="ck_users_status"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    phone: Mapped[str | None] = mapped_column(String(20))
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(20), default="customer", server_default="customer")
    status: Mapped[str] = mapped_column(String(20), default="active", server_default="active")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # Deleting a user removes their face profiles (DB ON DELETE CASCADE does the work)
    # but keeps authentication logs, detached (ON DELETE SET NULL).
    face_profiles: Mapped[list["FaceProfile"]] = relationship(
        back_populates="user", cascade="all, delete-orphan", passive_deletes=True
    )
    authentication_logs: Mapped[list["AuthenticationLog"]] = relationship(
        back_populates="user", passive_deletes=True
    )
    transactions: Mapped[list["Transaction"]] = relationship(back_populates="payer")


class Merchant(Base):
    __tablename__ = "merchants"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    business_name: Mapped[str] = mapped_column(String(160))
    password_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    transactions: Mapped[list["Transaction"]] = relationship(back_populates="merchant")
    payment_sessions: Mapped[list["PaymentSession"]] = relationship(back_populates="merchant")


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
    """A bill created by a merchant. Phase 5 attaches transactions to it."""

    __tablename__ = "payment_sessions"
    __table_args__ = (
        CheckConstraint("amount > 0", name="ck_payment_sessions_amount_positive"),
        CheckConstraint(
            "status IN ('CREATED', 'PAID', 'EXPIRED', 'CANCELLED')", name="ck_payment_sessions_status"
        ),
        Index("ix_payment_sessions_merchant_created", "merchant_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    merchant_id: Mapped[int] = mapped_column(ForeignKey("merchants.id"))
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    currency: Mapped[str] = mapped_column(String(3), default="INR", server_default="INR")
    order_reference: Mapped[str | None] = mapped_column(String(80))
    description: Mapped[str | None] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(20), default="CREATED", server_default="CREATED")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    merchant: Mapped[Merchant] = relationship(back_populates="payment_sessions")
    transactions: Mapped[list["Transaction"]] = relationship(back_populates="payment_session")


class Transaction(Base):
    __tablename__ = "transactions"
    __table_args__ = (
        CheckConstraint("amount > 0", name="ck_transactions_amount_positive"),
        CheckConstraint("status IN ('PENDING', 'SUCCESS', 'FAILED')", name="ck_transactions_status"),
        Index("ix_transactions_merchant_ts", "merchant_id", "timestamp"),
        Index("ix_transactions_payer_ts", "payer_id", "timestamp"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    transaction_id: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    payer_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    merchant_id: Mapped[int] = mapped_column(ForeignKey("merchants.id"))
    payment_session_id: Mapped[int | None] = mapped_column(
        ForeignKey("payment_sessions.id", name="fk_transactions_payment_session"), index=True
    )
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    payment_method: Mapped[str] = mapped_column(String(20), default="FACE_PAY", server_default="FACE_PAY")
    status: Mapped[str] = mapped_column(String(20), default="PENDING", server_default="PENDING")
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    merchant: Mapped[Merchant] = relationship(back_populates="transactions")
    payer: Mapped[User] = relationship(back_populates="transactions")
    payment_session: Mapped[PaymentSession | None] = relationship(back_populates="transactions")


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
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    user: Mapped[User | None] = relationship(back_populates="authentication_logs")
