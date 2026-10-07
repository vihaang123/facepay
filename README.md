# FacePay

**PCA-LDA Based Facial Authentication Framework for Secure Digital Payment Simulation**

An academic/research prototype. Payments are **simulated**: there is no UPI integration and no real money is processed. Biometric data is sensitive; this project is not production-ready for banking or financial use.

## Status

| Phase | Scope | State |
|-------|-------|-------|
| 1 | Foundation + architecture | Done |
| 2 | Auth + user/merchant system | Next |
| 3 | Facial dataset + PCA/LDA pipeline | Not started |
| 4 | Face authentication + liveness | Not started |
| 5 | Payment simulation + merchant system | Not started |
| 6 | Dashboards, analytics, polish | Not started |
| 7 | Testing, evaluation, deployment, docs | Not started |

No ML results exist yet. Any metrics in the final report will come from real experiments only.

## Stack

- Frontend: React, Vite, Tailwind CSS, Recharts (planned deploy: Vercel)
- Backend: Python, FastAPI, SQLAlchemy 2, Alembic
- ML: OpenCV, NumPy, Pandas, scikit-learn (PCA, LDA, classifier)
- Database: PostgreSQL (not Supabase)

## Layout

```
backend/   FastAPI app, models, Alembic migrations, tests
frontend/  React + Vite app
ml/        preprocessing, training, evaluation (Phase 3+)
docs/      architecture and report
```

## Local setup

### 1. PostgreSQL

Create a database and a user, then put the connection string in `backend/.env`.

```sql
CREATE USER facepay WITH PASSWORD '<your-password>';
CREATE DATABASE facepay OWNER facepay;
CREATE DATABASE facepay_test OWNER facepay;
```

### 2. Backend

```bash
cd backend
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # then edit DATABASE_URL and JWT_SECRET
alembic upgrade head
uvicorn app.main:app --reload --port 8000
```

API docs: http://localhost:8000/docs

### 3. Frontend

```bash
cd frontend
npm install
cp .env.example .env.local
npm run dev
```

## Tests

```bash
cd backend && python -m pytest -q          # uses TEST_DATABASE_URL or the facepay_test DB
cd frontend && npm test && npm run build
```

## Secrets

`.env` files are git-ignored. Only `.env.example` files are committed. Database credentials and the JWT secret are read from environment variables only.
