# Architecture (Phase 1)

```
React/Vite (Vercel)  ->  FastAPI  ->  ML pipeline (Phase 3)  ->  PostgreSQL
```

## Decisions

- **SQLAlchemy 2 + Alembic.** Schema changes go through migrations only. `alembic/env.py` reads `DATABASE_URL` from the environment, so no credentials live in `alembic.ini`.
- **Config.** `pydantic-settings` loads everything from env vars. The app refuses to start without `DATABASE_URL` and a `JWT_SECRET` of at least 16 characters.
- **CORS.** Explicit origin allow-list from `CORS_ORIGINS`; no wildcard.
- **Biometric storage.** `face_profiles.feature_data` is intended for processed feature vectors only. Raw face images are not stored. Encryption of this column is planned for Phase 3.
- **Constraints.** Role/status enums via CHECK constraints, positive transaction amounts, unique emails and transaction IDs, composite indexes for the merchant and payer history queries.
- **Health endpoint.** `/health` performs a real `SELECT 1` and reports `degraded` if the database is unreachable.

## Schema deviations from the original spec

- `users.role` allows `customer` or `admin`; merchants live in their own table as specified.
- `face_profiles` stores `model_version_id` as a foreign key plus `sample_count`, and `feature_data` as binary.
- `authentication_logs.user_id` is nullable with `ON DELETE SET NULL` so failed attempts by unknown faces can still be logged.
- `model_versions.evaluation_metrics` is JSONB and must only be filled from real evaluation runs.
