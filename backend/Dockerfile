# Academic-prototype backend image. Works on any container host (Render, Railway, Fly.io, a VPS).
# NOT built or run in the Phase 7 environment (no Docker daemon there); see docs/final/deployment-guide.md.
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 APP_ENV=production
WORKDIR /app

COPY requirements-lock.txt .
RUN pip install --no-cache-dir -r requirements-lock.txt

COPY alembic.ini .
COPY alembic ./alembic
COPY app ./app

RUN useradd --create-home --uid 10001 facepay
USER facepay

# One worker on purpose: the rate limiter and its counters are in process memory.
# Migrations run first; DATABASE_URL, JWT_SECRET, BIOMETRIC_KEY and CORS_ORIGINS come from the host's environment.
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1"]
