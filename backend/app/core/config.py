import base64
import binascii
from decimal import Decimal
from functools import lru_cache

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All configuration comes from environment variables. No secrets in code."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: str = "development"
    database_url: str
    jwt_secret: str
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 60
    cors_origins: str = "http://localhost:5173"
    # Per-IP limit on login/registration attempts (in-memory, single instance).
    rate_limit_enabled: bool = True
    auth_rate_limit_per_minute: int = 10
    # AES-256 key (32 random bytes, base64) protecting stored face crops, models and profiles.
    # Generate: python -c "from app.core.crypto import generate_key; print(generate_key())"
    biometric_key: str = ""
    # Per-IP limits (per minute) for the face endpoints; recognition and training are costly.
    face_rate_limit_per_minute: int = 60
    train_rate_limit_per_minute: int = 5
    # Face authentication attempts per user per minute (each attempt is expensive and security-relevant).
    face_auth_rate_limit_per_minute: int = 10
    # Largest request body accepted (face frames are base64 JPEGs; a 10-frame authentication is a few MB).
    max_request_bytes: int = 12_000_000
    # Checkout, confirmation and payment-session reads per customer per minute.
    payment_rate_limit_per_minute: int = 30
    # Enrolment uploads and the live frame check used by guided capture, per customer per minute.
    enroll_rate_limit_per_minute: int = 40
    assess_rate_limit_per_minute: int = 240

    # --- Payment safety limits (simulated INR). Enforced by the backend; the UI only displays them.
    per_transaction_limit: Decimal = Decimal("50000")
    daily_payment_limit: Decimal = Decimal("100000")  # per customer, successful payments in the last 24 hours
    payment_authorization_ttl_seconds: int = 120  # lifetime of the single-use ticket after face authentication
    max_auth_failures_per_session: int = 5  # counted biometric failures before a payment session is closed

    # --- Simulated wallet and customer-to-customer transfers. Everything here is simulated money.
    opening_balance: Decimal = Decimal("10000")  # granted once to every new customer, recorded as a ledger entry
    transfer_session_minutes: int = 10  # how long a reviewed transfer waits for face verification and confirmation
    request_ttl_days: int = 7  # a money request that nobody pays expires after this long
    facepay_id_change_cooldown_days: int = 30  # a customer may rename their FacePay ID this rarely
    resolve_rate_limit_per_minute: int = 20  # FacePay ID lookups per customer (limits guessing which IDs exist)
    transfer_rate_limit_per_minute: int = 20  # creating transfers and money requests per customer

    # --- Account-level biometric lockout: this many counted failures inside the window blocks further biometric
    # attempts until the oldest of them leaves the window.
    biometric_lockout_failures: int = 8
    biometric_lockout_window_minutes: int = 15

    # --- Risk-based authorization PROTOTYPE (not fraud detection). Any signal below requires the payment PIN.
    step_up_amount_threshold: Decimal = Decimal("10000")
    step_up_failure_count: int = 2  # counted biometric failures within the window below ...
    step_up_failure_window_minutes: int = 15
    step_up_rapid_attempts: int = 6  # ... or this many authentication attempts within 2 minutes
    step_up_pin_change_minutes: int = 60  # a PIN changed this recently also requires the PIN
    pin_max_attempts: int = 5
    pin_lockout_minutes: int = 15

    @field_validator("database_url")
    @classmethod
    def _driver_url(cls, v: str) -> str:
        """Hosted PostgreSQL providers hand out postgres:// or postgresql:// URLs; this app uses the psycopg 3 driver."""
        for prefix in ("postgres://", "postgresql://"):
            if v.startswith(prefix):
                return "postgresql+psycopg://" + v[len(prefix):]
        return v

    @field_validator("jwt_secret")
    @classmethod
    def _secret_not_empty(cls, v: str) -> str:
        if len(v) < 16:
            raise ValueError("JWT_SECRET must be at least 16 characters")
        return v

    @model_validator(mode="after")
    def _production_requires_real_secrets(self) -> "Settings":
        """Fail at startup, not at the first request, if a production deployment kept development placeholders."""
        if self.app_env.lower() == "production":
            if not self.biometric_key:
                raise ValueError("BIOMETRIC_KEY must be set when APP_ENV=production")
            try:
                key = base64.b64decode(self.biometric_key, validate=True)
            except (binascii.Error, ValueError):
                raise ValueError("BIOMETRIC_KEY must be base64 (32 random bytes)") from None
            if len(key) != 32:
                raise ValueError("BIOMETRIC_KEY must decode to exactly 32 bytes")
            if "change-me" in self.jwt_secret.lower():
                raise ValueError("JWT_SECRET still has the example placeholder value")
            origins = self.cors_origin_list
            if not origins or "*" in origins:
                raise ValueError("CORS_ORIGINS must list the exact frontend origin(s) in production, not * or empty")
        return self

    @property
    def is_production(self) -> bool:
        return self.app_env.lower() == "production"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
