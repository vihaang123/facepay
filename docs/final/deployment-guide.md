# Deployment guide

**Status: not deployed.** Deployment not completed because hosting-provider authorization was unavailable. No Render
tool existed in the build session, and the Vercel connection refused every write (HTTP 403, not authorised for the
account's scope). So there is no hosted frontend, backend or database, and this guide contains no live URLs. The
repository is deployment-ready; the steps in section 5 are what the account owner has to click through.

Everything is labelled **Verified locally** (run in the build environment, with evidence) or **Requires manual
deployment** (needs a Render / Vercel account and has not been run).

FacePay is an academic prototype with simulated payments. A public deployment would host real people's face data, so
treat it as a demo: use throwaway accounts and your own face or public research images, and read
[`security-assessment.md`](security-assessment.md) first.

## 1. Architecture

```text
Browser (HTTPS, camera permission)
   |
   v
Vercel          React + Vite static build        frontend/  (vercel.json: SPA rewrite + security headers)
   |  HTTPS, VITE_API_BASE_URL
   v
Render          FastAPI web service (Docker)     backend/   (OpenCV, PCA, LDA, KNN/SVM, AES-GCM biometric store)
   |  DATABASE_URL (internal)
   v
Render          PostgreSQL                       users, face profiles, payment sessions, transactions
```

| Part | Host | Config in the repo |
|---|---|---|
| Frontend | Vercel, Root Directory `frontend`, Vite preset | `frontend/vercel.json`, `frontend/.env.example` |
| Backend | Render Web Service, Docker runtime | `backend/Dockerfile`, `backend/requirements-lock.txt`, `render.yaml` (optional Blueprint) |
| Database | Render PostgreSQL | Alembic migrations in `backend/alembic` |

The backend needs roughly 500 MB of RAM (NumPy, scikit-learn and OpenCV are loaded). Trained models, face samples and
profiles are stored encrypted in PostgreSQL, not on disk, so Render's ephemeral filesystem is fine.

## 2. Environment variables (read from `backend/app/core/config.py`; none are invented)

### Backend (Render Environment tab, never in git). Full list with explanations: `backend/.env.example`

| Variable | Production | Notes |
|---|---|---|
| `APP_ENV` | required: `production` | Enables the startup secret checks; disables `/docs`, `/redoc`, `/openapi.json`. |
| `DATABASE_URL` | required | Use Render's **Internal Database URL**. `postgres://`, `postgresql://` and `postgresql+psycopg://` are all accepted (rewritten to the psycopg 3 driver). **Verified locally** with a `postgres://` URL. |
| `JWT_SECRET` | required | 16+ characters (use 48+); the example placeholder is refused. `python -c "import secrets; print(secrets.token_urlsafe(48))"` |
| `BIOMETRIC_KEY` | required | AES-256 key: 32 random bytes, base64. See section 3. |
| `CORS_ORIGINS` | required | Exact Vercel origin(s), comma separated, e.g. `https://your-app.vercel.app`. `*` or an empty list stops the app starting in production. |
| `FORWARDED_ALLOW_IPS` | recommended on Render: `*` | Read by uvicorn. Lets the per-IP rate limits see the real client behind Render's proxy. Only set it when the app is reachable only through that proxy. |
| `JWT_ALGORITHM`, `JWT_EXPIRE_MINUTES`, `RATE_LIMIT_ENABLED`, `AUTH_/FACE_/FACE_AUTH_/PAYMENT_/TRAIN_RATE_LIMIT_PER_MINUTE` | optional | Defaults in `.env.example`. Keep rate limiting on. |
| `PORT` | provided by Render | Read by the Docker start command (default 8000). Do not set it. |

`TEST_DATABASE_URL` is for pytest only; never set it on a host.

### Frontend (Vercel Project Settings > Environment Variables)

| Variable | Notes |
|---|---|
| `VITE_API_BASE_URL` | Public HTTPS URL of the Render service, e.g. `https://<your-service>.onrender.com`, no trailing slash. Not a secret, but compiled in at build time: **redeploy after changing it.** The source contains no hosted URL (default is `http://localhost:8000`). |

## 3. Biometric key

`BIOMETRIC_KEY` encrypts every stored face crop, model and profile (AES-256-GCM). It must come from Render's environment
and must never be committed; the repository contains only an empty placeholder.

The administrator generates it once, on any machine with the backend dependencies:

```bash
cd backend && python -c "from app.core.crypto import generate_key; print(generate_key())"
```

Paste the output into Render as `BIOMETRIC_KEY` and keep a private backup (password manager). Losing or changing it
makes all stored face data unreadable and every user must re-enrol. In production the app **refuses to start** if the
key is missing, is not base64, or does not decode to exactly 32 bytes (**verified locally**, with tests).

## 4. Start command and migrations

The Docker image's command is (module path `app.main:app` verified against the code):

```bash
alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1
```

Migrations therefore run on every start and are a no-op when the schema is current. To run them by hand
(Render Shell, or locally against the hosted URL): `cd backend && alembic upgrade head`. Keep one worker and one
instance; the rate limiter, model cache and training lock are in process memory.

**Verified locally** (PostgreSQL 16, Python 3.13 from `requirements-lock.txt`):

* `alembic upgrade head` on a completely empty database applied all 5 migrations; `alembic check` then reported no drift.
* That exact command run with `APP_ENV=production`, a `postgres://` URL, a freshly generated key and a generated JWT
  secret started cleanly: `GET /health` returned `{"status":"ok","database":"ok",...}` (it runs a real `SELECT 1`;
  `degraded` means the database is unreachable), `/docs` and `/openapi.json` returned 404, and register and login
  (database writes and reads) succeeded.
* CORS: the configured origin received `Access-Control-Allow-Origin`; another origin received none.
* Startup refused in production without `JWT_SECRET`/`DATABASE_URL`, without `BIOMETRIC_KEY`, and with `CORS_ORIGINS=*`.
* An encrypt/decrypt round trip with that production key.

**Not verified:** `docker build` (no Docker daemon was available, so the OpenCV-headless/NumPy/scikit-learn install on
`python:3.13-slim` is untested here; the same pins install and pass the suite in a clean Python 3.13 virtualenv), any
Render behaviour, TLS, behaviour behind Render's proxy, and `render.yaml` (written without Render access; check plan
names and sizes in the dashboard).

## 5. Deployment order (Requires manual deployment)

1. **Render: create PostgreSQL** (New > PostgreSQL). Copy its **Internal Database URL**.
2. **Render: create the Web Service** (New > Web Service, this GitHub repo, `main`). Runtime **Docker**, Dockerfile path
   `backend/Dockerfile`, Docker build context `backend`. One instance. Health check path `/health`. Use a plan with
   at least 1 GB RAM if the free/512 MB plan runs out of memory.
   Alternative: New > Blueprint, pointing at `render.yaml`, then fill in the two `sync:false` values.
3. **Set the environment variables** from section 2: `APP_ENV=production`, `DATABASE_URL` (internal URL),
   `JWT_SECRET`, `BIOMETRIC_KEY`, `CORS_ORIGINS` (a placeholder you will fix in step 8, for example
   `http://localhost:5173`; do not leave it at that), `FORWARDED_ALLOW_IPS=*`.
4. **Deploy.** The container runs `alembic upgrade head` and then starts the API. Watch the logs for the five migrations
   on first start.
5. **Verify** `https://<render-service>/health` returns `{"status":"ok","database":"ok",...}` and `/docs` returns 404.
6. **Vercel: import the repo** (Add New > Project). **Root Directory `frontend`**, Framework Preset **Vite**,
   build `npm run build`, output `dist` (the defaults). `frontend/vercel.json` gives the SPA rewrite (deep links such as
   `/checkout/<id>` load `index.html`) and the headers `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`
   and `Permissions-Policy: camera=(self), microphone=(), geolocation=()`.
7. **Set `VITE_API_BASE_URL`** (Production and Preview) to the Render URL and deploy.
8. **Update CORS:** set the Render `CORS_ORIGINS` to the Vercel origin (for example `https://your-app.vercel.app`, no
   trailing slash; add the production alias only, previews have other URLs) and let the service restart.
9. **Test the whole app** (sections 7 and 8).

## 6. Camera and HTTPS

The camera needs a secure context. On `http://localhost` the development camera flow works; the deployed Vercel site is
HTTPS, so it works there, and the browser must be allowed to use the camera for that site. On plain HTTP anywhere else
the browser exposes no camera API at all and the app shows "Camera not available" (it has no insecure fallback).
The HTTPS page must call an HTTPS API; an HTTP API would be blocked as mixed content. The Vercel header
`Permissions-Policy: camera=(self)` allows the camera only for the site itself.

## 7. Production checklist

- [ ] `APP_ENV=production`; `JWT_SECRET` and `BIOMETRIC_KEY` generated fresh, held only in Render's environment, key backed up
- [ ] `CORS_ORIGINS` is exactly the Vercel origin (not `*`, not localhost)
- [ ] Database URL is the internal URL; credentials not in the repository, logs or screenshots
- [ ] One backend instance, one worker, `FORWARDED_ALLOW_IPS=*` only because the service sits behind Render's proxy
- [ ] HTTPS on both origins; `/docs` and `/openapi.json` return 404
- [ ] Rate limiting enabled; demo accounts only; a privacy notice appropriate to your setting

## 8. Smoke test after deploying (Requires manual deployment)

Run these in order. Use a throwaway email. Replace `$API` (the Render URL) and `$APP` (the Vercel URL).

```bash
curl -s $API/health                                  # {"status":"ok","database":"ok",...}
curl -s -o /dev/null -w "%{http_code}\n" $API/docs   # 404 in production
curl -si $API/health | grep -i "cache-control\|x-content-type"   # no-store, nosniff
curl -s -X POST $API/auth/register -H 'content-type: application/json' \
  -d '{"name":"Smoke Test","email":"smoke@example.com","password":"Correct-horse-42"}'      # 201
curl -s -X POST $API/auth/login -H 'content-type: application/json' \
  -d '{"email":"smoke@example.com","password":"Correct-horse-42"}'                          # access_token
curl -s $API/users/me -H "authorization: Bearer <token>"                                    # 200 profile
curl -s $API/users/me                                                                       # 401
```

Then in the browser at `$APP`: the landing page shows the API as connected; register a customer; open Face setup (the
camera needs HTTPS and permission); capture samples; a model needs at least **two enrolled customers** to train; register a
merchant, create a payment, open the checkout link as the customer, run face authentication and the liveness challenge,
confirm, and check the receipt and both transaction histories. If you have no webcam on the demo machine, use the
simulated-camera run (`docs/browser-testing/`) and label it as simulated; it is not a physical-camera test.

## 9. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Backend exits at start with `BIOMETRIC_KEY must be set` / `must be base64` / `exactly 32 bytes`, `JWT_SECRET still has the example placeholder` or `CORS_ORIGINS must list the exact frontend origin(s)` | Production validator working as intended; set real values (section 2, 3). |
| Render deploy killed or restarting, out-of-memory in the logs | Plan too small for NumPy/scikit-learn/OpenCV; use a larger instance. |
| Frontend shows "can't reach the server" | Wrong `VITE_API_BASE_URL` (needs a rebuild after changing), backend asleep, or mixed content (HTTPS page calling an HTTP API). |
| Browser console shows a CORS error | `CORS_ORIGINS` does not exactly match the page origin (scheme, host, no trailing slash). |
| `/health` says `degraded` | Database unreachable: URL, firewall, `sslmode`. |
| `ModuleNotFoundError: psycopg2` | `DATABASE_URL` uses a driver prefix other than `postgres://`, `postgresql://` or `postgresql+psycopg://`. |
| Camera does not start | Page is not HTTPS, permission denied, or another app holds the camera. |
| "Not enough users" when training | The shared model needs at least two enrolled customers, each with enough samples. |
| Everyone must re-enrol after a deploy | `BIOMETRIC_KEY` changed or was lost. |
| 429 responses | Rate limit; if everyone gets them, `FORWARDED_ALLOW_IPS=*` is missing so all clients look like one address. |
| 413 on face upload | Request over 12 MB (frames are normally a few MB). |
