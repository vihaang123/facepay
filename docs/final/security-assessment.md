# Security assessment

This is a review of an academic prototype by its authors. It is **not** a penetration test, an external audit or a
compliance assessment, and nothing here means the system is secure enough for real money or real biometric data. Every
"existing mitigation" below can be found in the code and, where stated, in the automated tests. "Residual risk" is what
is left after that mitigation; several of those risks are serious for a real product.

Evidence behind the claims: 341 backend tests (`backend/tests/`, real PostgreSQL), 178 frontend tests, a 44-step
real-browser run, and the earlier review in [`../security-review.md`](../security-review.md). Face-recognition numbers
referred to here are in [`evaluation-results.md`](evaluation-results.md).

## Authentication and authorization

| Threat | Existing mitigation | Residual risk |
|---|---|---|
| Stolen password database | Argon2id password hashes; no plaintext or reversible storage | A weak user password is still weak; no breach-password check. No email verification or password reset exists. |
| Forged or tampered token | JWT with pinned algorithm (HS256), required `exp`, `sub`, `role` claims and a `type=access` claim; wrong-type, expired and garbage tokens are rejected (tests) | One shared symmetric secret; no key rotation. Tokens cannot be revoked before expiry (60 min); no refresh tokens. |
| Token theft from the browser | Short lifetime; `no-store` on API responses; no third-party scripts | Tokens are kept in `localStorage`, so any cross-site-scripting bug would expose them. No Content-Security-Policy is set. |
| Customer using merchant functions and the reverse | Separate tables, logins and role guards on every route (server side) and in the UI; wrong role gets 403 (tests, browser run) | Roles are coarse; there is no admin console or audit UI. |
| Reading another user's payments or receipts | Every payment/transaction query is scoped by the caller's id; other people's sessions, transactions and receipts return 404 (tests) | None known in the tested paths; not exhaustively fuzzed. |
| Disabled account keeps access | The account state is checked against the database on each authenticated request, not only at login (test) | Face-auth endpoints for a disabled account are limited as designed but not separately pen-tested. |
| Credential stuffing / brute force | Per-IP rate limit on login and registration (default 10/min) | In-memory and per process; behind a proxy all clients share one address; resets on restart; no per-account lockout. |

## Biometric data

| Threat | Existing mitigation | Residual risk |
|---|---|---|
| Database leak exposes faces | Face crops (64x64 grayscale, equalised, not the raw frame), the trained model and each user's profile are stored AES-256-GCM encrypted under `BIOMETRIC_KEY`, bound to their row/version as authenticated data (tests). Raw camera frames are never stored. | One application key, no rotation or KMS. Whoever has both the database and the key (or the running server) can read everything. A 64x64 crop is still a face. |
| Biometric data returned by the API | No endpoint returns an image, crop or feature vector; responses never name another user (tests) | Authentication responses include a match confidence and a model distance for the signed-in user. |
| Tampered model artifact executed on load | A model blob is unpickled only after it authenticates under the key, and only if library versions match | Pickle remains risky if the key and database are both compromised. |
| Someone else's face accepted (impostor) | Per-user distance threshold plus identity-match plus minimum-confidence policy (`app/services/auth_policy.py`) | **Weak.** On ORL, an impostor whose face the classifier assigns to the claimed user is accepted far too often at the deployed threshold (see evaluation: about 45% at p70, an upper-bound style scenario); a random impostor claim is accepted about 2.3%. This is a classroom-scale model, not a secure verifier. |
| Genuine user locked out | Retry within the session; clear messages | About 20% of genuine ORL probes are rejected at the deployed threshold. |
| Second person in frame | Authentication is rejected when another face is at least 15% the size of the largest (`MULTIPLE_FACES_DETECTED`, tests) | Faces in the background below that size are ignored. |
| Model confuses users after others join or leave | Retraining on every change is deliberate; deleting your data retires the active model | Anyone with a customer account can trigger training that includes every enrolled user (prototype). |
| Biometric data retention / consent | Users can delete their samples and profile from the UI (rate limited) | No formal consent record, retention schedule or data-protection assessment. |

## Liveness

| Threat | Existing mitigation | Residual risk |
|---|---|---|
| Printed photo or still image held to the camera | Challenge-response: the user must move their head sideways in a randomly requested direction (left/right); the face box must move at least 0.10 box widths that way and not the opposite way; the two baseline frames must agree within 0.05. Measured detector jitter on static images is at most about 0.013 box widths, so the threshold is more than 7x the jitter; 35 of 35 static test sequences failed as intended. | **A flat photo that is slid sideways satisfies the rule** (35 of 35 simulated slides passed, see evaluation). The check measures face-box movement, not 3D structure. |
| Replayed video of the user | Challenges are server-issued, random, single use and expire after 60 s (tests); a recorded video of the *requested* direction would still pass | Not defended. No depth, texture, reflection or blink analysis. |
| Reusing an old challenge | Challenge ids are DB-backed, single-use and time-limited (tests) | None known. |
| Deepfake / injected camera feed | Not addressed | Out of scope; would defeat this system. |

Liveness here is a basic challenge-response signal. It is **not** a presentation-attack-detection system and has not been
tested on real webcams or against any standard attack protocol.

## Payment authorization (simulated)

| Threat | Existing mitigation | Residual risk |
|---|---|---|
| Client changes the amount | Amount is read only from the stored payment session; an optional `expected_amount` that differs gives 409 `AMOUNT_MISMATCH` (tests) | None known. |
| Replaying or reusing an authorization | Ticket is 32 random bytes, only its SHA-256 hash is stored, valid 120 s, single use, bound to customer and session; any failure returns the same `AUTHORIZATION_INVALID` (tests) | Tickets are shown once to the client and live in memory in the browser. |
| Using a ticket for another session or customer | Binding to (customer, session) checked on confirm (tests) | None known. |
| Double charge / race | Confirm takes a row lock; a partial unique index allows one SUCCESS transaction per session (concurrency test) | Single-database design; not tested across multiple application instances. |
| Expired or cancelled sessions paid | State machine CREATED to AUTHENTICATED to PAID/FAILED/EXPIRED/CANCELLED enforced server side (tests) | Expiry is evaluated on access; there is no background sweeper. |
| Guessing faces on a session | After 5 counted failed face attempts the session becomes FAILED; face-auth attempts are rate limited per user | Attempts are per session; a new session resets the counter (the per-user rate limit still applies). |
| Checkout link shared | Link needs a signed-in customer and that customer's face | Bearer-style: any signed-in customer with the link can try to pay it. |
| Real money loss | There is none: no payment network, wallet or balance exists | Not applicable, and not suitable for real funds. |

## API and web layer

| Threat | Existing mitigation | Residual risk |
|---|---|---|
| Injection | SQLAlchemy with bound parameters only; list search text escaped so `%` and `_` are literal; Pydantic schemas with `extra="forbid"` and length/pattern limits | None known; no fuzzing was done. |
| Oversized requests | 413 when `Content-Length` exceeds 12 MB; image size and pixel caps checked from the header before decoding | A chunked request without `Content-Length` is not stopped by this check; limit at the proxy too. |
| Abuse of expensive endpoints | Per-IP limits on face upload, recognition, training and delete; per-user limit on authentication; bounded limiter memory | In-memory, per process, not distributed. |
| Caching of sensitive responses | `Cache-Control: no-store` on every API response | None known. |
| Clickjacking, MIME sniffing, referrer leakage | `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer` on the API and in `frontend/vercel.json`; camera allowed for the site itself only via `Permissions-Policy` | No Content-Security-Policy and no HSTS configured by the app. |
| Information leakage in errors | Errors are `{code, message}` written for people; the UI never shows a 5xx body | Internal logs were not reviewed for sensitive content beyond the absence of passwords/tokens/biometric data in the code paths read. |
| Interactive API docs exposed | Disabled when `APP_ENV=production` | Enabled in development by design. |

## Deployment

| Threat | Existing mitigation | Residual risk |
|---|---|---|
| Secrets committed | `.env*` git-ignored except `.env.example`; repository and release ZIP secret-scanned (patterns plus the real local values, never printed) | Scans are pattern based. |
| Misconfigured production | Startup validator rejects missing `BIOMETRIC_KEY` and the example `JWT_SECRET`; CORS is an explicit allow-list | Nothing stops weak but non-placeholder secrets or a permissive `CORS_ORIGINS` value. |
| Plain HTTP | Documented as a requirement (the camera also needs HTTPS) | The app does not enforce HTTPS or HSTS. |
| Several instances | Documented: one instance, one worker | Rate limits, model cache and training lock are per process. |
| Hosted provider | Not deployed in Phase 7 (see [`deployment-guide.md`](deployment-guide.md)) | Provider-level controls, TLS and backups are unreviewed. |

## Summary

The payment-authorization and data-protection design is careful for a prototype: server-side amounts, single-use hashed
tickets, atomic confirmation, encrypted biometric storage and consistent authorization checks, all with automated tests.
The weakest parts are the ones the evaluation shows: the open-set identity check and the liveness challenge. Together
they mean a determined person with a photo of the account holder could plausibly get through. Treat FacePay as a
demonstration of the PCA+LDA approach and of sound payment-flow structure, not as a secure biometric payment system.
