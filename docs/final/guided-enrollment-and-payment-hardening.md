# Guided enrollment and payment-authorization hardening

This document describes the change made after the first deployment: automatic, guided face setup, and a stricter,
more honest payment-authorization path. It records what is enforced where, how to tune it, what was tested, and what
is still **not** protected. FacePay is an academic prototype. Payments are simulated and no real money moves.

The principle behind every change here: **recognising a face is not the same as authorizing a payment.**
Account sign-in, face recognition, a basic liveness check, the payment authorization, the customer's own confirmation
and the simulated transaction are separate steps with separate records. None of them is a boolean that another step can
set. The PCA + LDA recognition pipeline itself was not changed.

## 1. Guided enrollment

### What the customer sees

Face setup opens the camera, shows a face outline and walks through five head positions: straight, left, right, up and
down (three samples each, 15 in total). FacePay captures each sample automatically once the picture is good and steady.
There is no per-sample Capture button and no manual pose picker. The screen shows the current instruction, a row of five
steps, overall progress ("7 of 15"), the per-position count and one line of plain feedback. A short "Captured"
confirmation appears after each sample. At the end the screen says **Face setup complete** and prepares the shared
model. No recognition jargon appears in the enrollment card; an optional "How FacePay works" section explains it.

Feedback is human wording only: "Move a little closer", "Move slightly farther away", "Center your face", "Keep your face
inside the frame", "Improve the lighting", "Hold still", "Only one face should be visible", "Face the camera" (and
"remove sunglasses" if no face is found for a while). No thresholds or scores are shown.

### State machine

`frontend/src/utils/enrollMachine.js` is a pure reducer. States: `IDLE`, `CAMERA_STARTING`, `POSITION_FACE`,
`CHECKING_QUALITY`, `CAPTURING`, `CAPTURE_SUCCESS`, `NEXT_POSE`, `COMPLETED`, `ERROR`.

```
IDLE -> CAMERA_STARTING -> POSITION_FACE <-> CHECKING_QUALITY -> CAPTURING -> CAPTURE_SUCCESS -> (NEXT_POSE ->) POSITION_FACE ... -> COMPLETED
                  \-> ERROR (camera blocked / unsupported / lost, network trouble)
```

A capture happens only when, for the whole stability window and after the cooldown: exactly one face is found, it is
centred (straight pose) or inside the frame (turned poses), its size is in range, brightness and sharpness are acceptable,
the picture is steady, and the head position looks right for the pose. If a server rejection comes back, the machine
returns to `POSITION_FACE` with a cooldown and a plain message.

### Where the numbers live

All timings and thresholds are in `frontend/src/utils/enrollConfig.js` (`ENROLL_CONFIG`): poll interval, stability
window, cooldown, flash and next-pose durations, pose-relax timeout, geometry limits, brightness, sharpness and motion
limits, the "no face" hint count and the error budget. Nothing is hardcoded in components.

### How the frontend sees the face without a detector

The browser has no face detector (no new dependency was added). While positioning, it sends a frame about twice a second
to `POST /faces/assess`, a stateless server-side check that stores nothing and returns `{state, faces, face:{cx,cy,width,height}}`.
The browser adds cheap canvas readings (brightness, edge strength, motion between readings). Pose is inferred from how
the face box moved relative to the straight-ahead position.

**This head-position check is a heuristic.** It cannot prove which way a head is turned, and the label sent with each
sample (`neutral`, `turn_left`, ...) is claimed by the client and cannot be verified by the server. For that reason the pose
condition relaxes after `poseRelaxMs` (every other condition still applies), and acceptance never depends on it.

### The server stays the authority

Every captured sample goes to `POST /faces/samples`, which re-runs the server's own checks (one face, size, brightness,
sharpness, alignment) and decides. Frontend guidance only improves the experience; it cannot make a bad sample valid.

## 2. Enrollment security

* Authenticated, per-user rate limits: samples and removals (`ENROLL_RATE_LIMIT_PER_MINUTE`, default 40) and live checks
  (`ASSESS_RATE_LIMIT_PER_MINUTE`, default 240). Sample count is capped per user.
* Near-duplicate rejection: a frame whose normalised crop is almost identical to one already stored for the user is
  refused with `DUPLICATE_SAMPLE` (409). The threshold `DUPLICATE_MAX_MEAN_DIFF` (1.5, in `app/ml/config.py`) is a
  **provisional** value that was not tuned on webcam data.
* Raw frames are never stored. Only the 64x64 equalised grayscale crop is kept, encrypted with AES-GCM.
* The response to a sample contains `accepted`, `next_pose`, `progress {captured, required}`, the image-quality flags and
  the enrollment summary. It never contains feature vectors, crops or classifier scores.
* Guided progress is derived from stored samples, so a reload or a second device resumes where the server says.

Not protected: a person who is willing to enroll someone else's photo (or a screen) under their own account. Enrollment
has no anti-spoofing, and the pose labels are unverifiable.

## 3. Payment authorization

### Separation of decisions

1. Account authentication (JWT).
2. Face recognition (PCA + LDA + classifier + per-user distance limit).
3. Basic liveness check (one random head-turn challenge).
4. Payment authorization: a single-use ticket created by the server only when 2 and 3 pass.
5. Customer confirmation: the customer reviews merchant, amount and order and confirms.
6. Simulated transaction.

The authentication screen shows these as distinct stages: Face detected, Identity recognized, Basic liveness check passed,
Payment authorization created, Customer confirmation, Payment processed.

### What an authorization is bound to

The ticket is 32 random bytes; only its SHA-256 hash is stored. The server stores, with it: customer, payment session,
merchant, amount, currency, order reference, face-model version, issue and expiry time (`PAYMENT_AUTHORIZATION_TTL_SECONDS`,
default 120) and whether a PIN is required. It is single use. No biometric data is in the ticket, in URLs or in the request.

On confirm the server checks, in order: face payments enabled; session payable; the details the customer was shown
(`expected_amount`, `expected_merchant`, `expected_order_reference` → 409 `AMOUNT_MISMATCH` / `MERCHANT_MISMATCH` /
`ORDER_MISMATCH`); the ticket (invalid, used, expired); the stored snapshot against the session and the active model
version (any mismatch revokes the ticket, 403 `AUTHORIZATION_INVALID`); amount limits; the PIN if required. Only then is
the ticket consumed and the transaction written. The amount charged is always the session's own.

### Risk-based step-up (a prototype)

Shown to the customer as "Risk-based authorization prototype". A payment PIN (6 digits, Argon2id, optional) is requested
only when the server finds a higher-risk payment: an amount at or above `STEP_UP_AMOUNT_THRESHOLD` (default ₹10,000),
repeated recent face failures, many attempts in a short time, or a recently changed PIN. It is not asked for on ordinary
payments. If a PIN is needed and none is set, confirmation is blocked and the customer is pointed to Security. Wrong PINs
are counted; `PIN_MAX_ATTEMPTS` (5) failures lock the PIN for `PIN_LOCKOUT_MINUTES` (15).

This is a rules sketch, not a fraud engine. It has no device or network signals and no learning.

### Limits, lockout and enumeration

* `PER_TRANSACTION_LIMIT` (₹50,000) and `DAILY_PAYMENT_LIMIT` (₹1,00,000, rolling 24 h), enforced on checkout creation,
  authentication and confirmation. These are simulated limits.
* `MAX_AUTH_FAILURES_PER_SESSION` (5) fails the session. `BIOMETRIC_LOCKOUT_FAILURES` (8) within
  `BIOMETRIC_LOCKOUT_WINDOW_MINUTES` (15) blocks face authentication for the account with the message "Too many
  unsuccessful attempts. Please try again later or use another verification method." (429, `Retry-After`).
* Only failures that look like attempts count (identity, liveness); camera problems do not. Error messages do not reveal
  whether an email exists or whose face was compared.
* Rate limits are in memory and per process (the deployment runs one worker on purpose). They are not shared across
  instances.

## 4. Customer security page

`/security` (desktop navigation, and linked from Profile on phones): face payments on/off switch; last successful face
check; recent face checks (result and category only), recent payments and security events; payment PIN set, change,
remove (all need the account password); remove face data and re-enroll; limits; the honest explanation.

Turning face payments off makes the server refuse face authentication and confirmation (`BIOMETRIC_DISABLED`). Removing
face data deletes the samples, revokes the profile and retires the model that included them, so face payments stop until
the person sets up again. Note that the face model is shared: removing one person's data retires the shared model and
everyone must retrain. That is existing behaviour, not new.

Audit: each face attempt keeps its result, reason category, timestamp and the session and transaction reference. Security
events (`PIN_SET`, `PIN_FAILED`, `BIOMETRIC_DISABLED`, `FACE_DATA_REMOVED`, `PAYMENT_CONFIRMED`, ...) are stored in
`security_events`. No images, vectors or scores are written there.

## 5. API and migration

* New: `POST /faces/assess`, `GET /security/overview`, `PUT /security/biometric`, `PUT /security/pin`,
  `POST /security/pin/remove`.
* Changed: `POST /faces/samples` response adds `next_pose` and `progress`; `GET /faces/enrollment` adds `guided`;
  `POST /payments/sessions/{id}/confirm` now requires `expected_amount`, `expected_merchant`, `expected_order_reference`
  and accepts `pin`; the authorization returned by authentication adds `step_up_required`, `step_up_reasons`, `pin_set`;
  receipts add `authentication`.
* Migration `0006` adds the new columns and the `security_events` table. `alembic upgrade head` and `alembic check`
  were run on a local database. **On deploy, existing active authorizations become unusable** because their snapshot is
  empty. They live two minutes, so this has no lasting effect. Enrollment samples remain valid.
* The old client (before this change) cannot confirm a payment because it does not send the merchant and order. Deploy
  the frontend and backend together.

## 6. Honest limits of the prototype

* The liveness check is a basic, movement-based challenge. It does not defend against deepfakes, replayed or injected
  video, masks, or any advanced presentation attack, and it was not evaluated on real webcams.
* Recognition accuracy was measured on the public ORL dataset only (see `evaluation-results.md`), not on webcam data.
* Guided capture was exercised in a real Chromium browser with a **simulated** camera (ORL photographs on a canvas).
  It was not tested with a physical webcam, real lighting or a person turning their head. The brightness, sharpness,
  motion and head-position thresholds are untuned defaults.
* Pose labels are client-asserted. The duplicate threshold is provisional.
* Rate limits and lockouts are in memory per process.
* Nothing here is suitable for real funds.

## 7. Tests

Backend (real PostgreSQL, synthetic face scenes): `tests/test_payment_security.py` covers the binding matrix (customer,
session, merchant, amount, order, expiry, model version, single use, replay, tampering in the database), mismatch codes,
limits, step-up and PIN rules and lockout, biometric lockout and switch, face-data removal, the overview and audit,
the receipt label, and enrollment (guided progress, duplicates, assess, rate limit, authorization). The mandatory
regression is there: an authorization issued to Customer A for Merchant A and ₹1,499 cannot be used by Customer B, for
Merchant B, for ₹5,000, in another session or for another order, and cannot be used again after it is consumed.

Frontend (Vitest + Testing Library): state-machine transitions and the full 15-sample sequence, quality guidance for
every message and the head-position rules (`src/utils/enroll.test.js`); the guided page end to end with a mocked camera
(auto-capture without any click, pose progression, stability window, every feedback message, server rejections,
duplicate frames, completion and training, training failure, camera blocked and unsupported, reduced motion, phone-first
layout and live-region markup, no jargon, no image rendered); checkout stages, explicit confirmation, PIN step-up,
lockout and limit messages and honest wording; the Security page.

Browser (Playwright, simulated camera): see `docs/browser-testing/README.md`.
