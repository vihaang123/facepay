# Real-browser test (Phase 6)

`run.mjs` drives the **built frontend** in headless Chromium (Playwright) against the **real API and PostgreSQL**. It is
not part of the unit-test suites (it needs the whole stack running) and is kept so the run can be repeated.

## What this is, and what it is not

* Real: Chromium, the production build of the frontend, the FastAPI server, PostgreSQL, the PCA + LDA model, the liveness
  policy, the single-use authorization and the payment transaction. Registration, face setup, training, checkout,
  authentication, confirmation, receipts, history and the merchant flow are all done through the UI.
* **Simulated: the camera.** No physical webcam was used. The script replaces `navigator.mediaDevices.getUserMedia` with a
  canvas stream that shows ORL dataset photographs, and slides the face sideways to imitate a head turn. So these runs
  exercise the real camera *code path* (`getUserMedia` → `<video>` → frame capture → upload) but say nothing about how a
  real webcam, real lighting or a real head turn behave. The head movement is a horizontal slide of a photo, not a person turning.
* The photos are the public ORL dataset (grayscale, 92×112, one person per subject). The browser-enrolled account uses ten
  photos of one subject; five further subjects are enrolled through the API so that LDA has at least two classes. The test
  server runs with `MIN_SAMPLES_PER_USER=8` (ORL only has ten photos per person) and raised rate limits.
* Accessibility: `axe-core` (WCAG 2.0/2.1 A and AA rules) is run on the pages listed in the output. Automated checks find
  only some problems; no manual screen-reader or full keyboard audit was done, and **WCAG conformance is not claimed**.

## Running it

```
# 1. PostgreSQL up, migrations applied, backend/.env set (CORS_ORIGINS=http://localhost:5173)
# 2. API (from backend/): relaxed limits and 8-sample minimum, for the test only
AUTH_RATE_LIMIT_PER_MINUTE=1000 FACE_RATE_LIMIT_PER_MINUTE=1000 FACE_AUTH_RATE_LIMIT_PER_MINUTE=1000 \
TRAIN_RATE_LIMIT_PER_MINUTE=100 PAYMENT_RATE_LIMIT_PER_MINUTE=1000 PYTHONPATH=. \
python -c "from app.ml import config as c; c.MIN_SAMPLES_PER_USER = 8; import uvicorn; from app.main import app; uvicorn.run(app, host='127.0.0.1', port=8000)"
# 3. frontend: npm run build && npx vite preview --port 5173 --host localhost
# 4. seed + run (needs `playwright` and `axe-core` installed where run.mjs lives, and the ORL .npz with arrays X, y)
ORL_NPZ=/path/to/orl.npz python seed.py && node run.mjs
```

The script prints PASS/FAIL per step, saves screenshots under `shots/` and `results.json`.

## Result of the Phase 6 run

44 of 44 steps passed on the final run; axe reported no WCAG A/AA violations on any scanned page. The first run had
13 failing steps. Their causes were: the simulated camera moved the face between the first two baseline frames (a test
artefact, which the liveness policy correctly rejected as "already moving"), two mistakes in the test script, and one
real UI bug that this run found: a visually hidden label inside a scrollable table escaped its container and made the
mobile merchant dashboard scroll sideways by 46 px (fixed).

Steps covered: landing at three viewport sizes; customer and merchant registration; keyboard focus; camera on, capture
of ten samples, training and recognition; the in-page delete confirmation; merchant creates a payment and monitors it;
checkout amount; face authentication with liveness; hidden technical details; confirmation; receipt; reloading a paid
checkout; customer and merchant dashboards, transaction lists with filter/search/sort; a different person rejected; a
motionless face failing liveness; camera permission denied; network error, 500 and 429 messages; 401 returning to the
login page with an explanation; unknown routes; route guards between the two roles; tablet and phone layouts without
horizontal scrolling; the mobile menu; and a complete payment on a 390×844 screen.
