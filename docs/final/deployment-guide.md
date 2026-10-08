# Deployment guide

**Status: not deployed.** Phase 7 prepared and checked the configuration, but no hosted frontend, backend or database was
created. Deploying the frontend alone would give a page whose every API call fails, and no backend or database host
account was available to this project. Nothing below has been run against a hosted provider; the parts that were
verified locally are marked **verified locally**. Do not read this guide as proof of a working public deployment.

FacePay is an academic prototype with simulated payments. A public deployment would host real people's face data, so treat
it as a demo: use throwaway accounts and your own face or public research images, and read
[`security-assessment.md`](security-assessment.md) first.

## 1. What gets deployed

| Part | Where it can run | Config in the repo |
|---|---|---|
| Frontend (static React build) | Vercel (or any static host) | `frontend/vercel.json`, `frontend/.env.example` |
| Backend (FastAPI, includes the PCA+LDA pipeline) | Any container host (Render, Railway, Fly.io, a VPS) | `backend/Dockerfile`, `backend/requirements-lock.txt` |
| Database | Any PostgreSQL 14+ (a free tier of a hosted provider is enough) | Alembic migrations in `backend/alembic` |

The backend needs roughly 500 MB of RAM (NumPy, scikit-learn and OpenCV are loaded; training builds a small matrix per
user). A free tier that sleeps will make the first request slow.

## 2. Prerequisites

* Python 3.13 (the version the code and `requirements-lock.txt` were tested with) or the provided Dockerfile
* Node 20+ for the frontend build
* A PostgreSQL database you can connect to over TLS, and its connection string
* HTTPS on both sites. Browsers only allow camera access on HTTPS (or `localhost`), so the camera will not start on plain HTTP.

## 3. Environment variables

### Backend (set in the host's secret/environment settings, never in git)

| Variable | Required | Notes |
|---|---|---|
| `APP_ENV` | yes | `production`. Refuses to start without `BIOMETRIC_KEY` or with the example `JWT_SECRET`; turns off `/docs`, `/redoc`, `/openapi.json`. |
| `DATABASE_URL` | yes | `postgres://`, `postgresql://` and `postgresql+psycopg://` URLs are all accepted (the first two are rewritten to the psycopg 3 driver; **verified locally** by a unit test). Add `?sslmode=require` if your provider needs it. |
| `JWT_SECRET` | yes | At least 16 characters; use 48+ random characters. `python -c "import secrets; print(secrets.token_urlsafe(48))"` |
| `BIOMETRIC_KEY` | yes | 32 random bytes, base64: `python -c "from app.core.crypto import generate_key; print(generate_key())"` run in `backend/`. **Back it up.** Losing or changing it makes every stored face sample, model and profile unreadable (users must re-enrol). |
| `CORS_ORIGINS` | yes | Exact frontend origin(s), comma separated, e.g. `https://your-app.vercel.app`. No wildcard, no trailing slash. |
| `JWT_ALGORITHM`, `JWT_EXPIRE_MINUTES` | no | Defaults `HS256`, `60`. |
| `RATE_LIMIT_ENABLED`, `AUTH_/FACE_/FACE_AUTH_/PAYMENT_/TRAIN_RATE_LIMIT_PER_MINUTE` | no | Defaults are in `backend/.env.example`. Keep rate limiting on. |
| `PORT` | host-provided | The Dockerfile listens on `$PORT` (default 8000). |

`TEST_DATABASE_URL` is for pytest only and must point at a database whose name ends in `_test`. Never set it on the host.

### Frontend (Vercel project settings)

| Variable | Notes |
|---|---|
| `VITE_API_BASE_URL` | Public URL of the backend, e.g. `https://facepay-api.example.com`, no trailing slash. It is compiled into the bundle at build time, so changing it needs a rebuild. It is not a secret. |

## 4. Database setup

1. Create an empty PostgreSQL database (any name) and a user that owns it.
2. Put its connection string in `DATABASE_URL` on the backend host.
3. Schema is created only by migrations: `alembic upgrade head` (the Docker image runs it at every start; it is a no-op when
   the schema is current). Five migrations exist (`0001`..`0005`). **Verified locally**: `alembic upgrade head` on an empty
   database, then `alembic check` reports no drift between the models and the migrations.

## 5. Backend deployment (container host)

The simplest path that needs no code changes is a Docker web service built from `backend/`:

1. Create a web service from this repository with **root directory `backend`** and **Dockerfile** build.
2. Set the environment variables from section 3.
3. Health check path: `/health` (returns `{"status":"ok","database":"ok",...}` and does a real `SELECT 1`; `degraded` means the database is unreachable).
4. Keep **one instance and one worker**. The rate limiter, the model cache and the training lock live in process memory.
   Several workers or instances would each count separately and could train concurrently.

Without Docker: `pip install -r requirements-lock.txt`, then
`alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port $PORT --workers 1`.

What was and was not checked for the backend:

* **Verified locally:** the production settings validator (refuses to start without `BIOMETRIC_KEY` / with the example
  secret), `/docs` disabled in production, health endpoint, migrations on an empty database, the dependency set installing
  into a clean Python 3.13 virtualenv and passing the full test suite.
* **Not verified:** `docker build` (there was no Docker daemon in the Phase 7 environment), any hosted provider, TLS, a
  hosted PostgreSQL, behaviour behind a reverse proxy.

Behind a proxy the app sees the proxy's address as the client, so the per-IP rate limits become effectively global.
For anything beyond a demo, configure forwarded headers and also limit request body size at the proxy (the app's own 12 MB
limit trusts the `Content-Length` header).

## 6. Frontend deployment (Vercel)

1. Import the repository, set **Root Directory** to `frontend`.
2. Framework preset: Vite. Build command `npm run build`, output directory `dist` (these are the defaults).
3. Add `VITE_API_BASE_URL` (Production and Preview) pointing at the backend.
4. Deploy. `frontend/vercel.json` already provides the single-page-app rewrite (deep links such as `/checkout/<id>` load
   `index.html`) and response headers: `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and
   `Permissions-Policy: camera=(self), microphone=(), geolocation=()`.
5. Add the final Vercel URL to the backend's `CORS_ORIGINS` and redeploy/restart the backend. Preview deployments have
   different URLs; add them only if you need them.

**Verified locally:** `npm run build` (production build, no dev-only code or secrets in `dist`; the only environment value
compiled in is `VITE_API_BASE_URL`), and the built app served by `vite preview` passing the 44-step browser run.
**Not verified:** the Vercel build itself and the SPA rewrite on Vercel. No Content-Security-Policy is set (see the
security assessment).

## 7. Production configuration checklist

- [ ] `APP_ENV=production`; `JWT_SECRET` and `BIOMETRIC_KEY` generated fresh, stored only in the host's secret store, and the key backed up
- [ ] `CORS_ORIGINS` is exactly the frontend origin
- [ ] Database reachable over TLS; credentials not in the repository, logs or screenshots
- [ ] One backend instance, one worker
- [ ] HTTPS on both origins
- [ ] `/docs` and `/openapi.json` return 404
- [ ] Rate limiting enabled
- [ ] Demo accounts only; a privacy notice appropriate to your setting (see the report's ethical section)

## 8. Smoke test after deploying

Run these in order. Use a throwaway email. Replace `$API` and `$APP`.

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
| Backend exits at start with `BIOMETRIC_KEY must be set` / `JWT_SECRET still has the example placeholder` | Production validator working as intended; set real values. |
| Frontend shows "can't reach the server" | Wrong `VITE_API_BASE_URL` (needs a rebuild after changing), backend asleep, or mixed content (HTTPS page calling an HTTP API). |
| Browser console shows a CORS error | `CORS_ORIGINS` does not exactly match the page origin (scheme, host, no trailing slash). |
| `/health` says `degraded` | Database unreachable: URL, firewall, `sslmode`. |
| `ModuleNotFoundError: psycopg2` | `DATABASE_URL` uses a driver prefix other than `postgres://`, `postgresql://` or `postgresql+psycopg://`. |
| Camera does not start | Page is not HTTPS, permission denied, or another app holds the camera. |
| "Not enough users" when training | The shared model needs at least two enrolled customers, each with enough samples. |
| Everyone must re-enrol after a deploy | `BIOMETRIC_KEY` changed or was lost. |
| 429 responses | Rate limit; behind a proxy all clients share one address. |
| 413 on face upload | Request over 12 MB (frames are normally a few MB). |
