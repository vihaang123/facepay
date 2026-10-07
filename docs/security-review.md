# Security review (Phase 6)

A focused review of the prototype, not an audit and not a penetration test. FacePay is an academic project with
simulated payments; nothing here makes it suitable for real money or real biometric data at scale.

## Reviewed, and what was found

| Area | Finding |
|------|---------|
| Authentication | Argon2id password hashes; JWTs with a pinned algorithm, an expiry and a token-type claim; separate customer and merchant login. Unchanged. |
| Authorization | Every payment and transaction query is scoped by the signed-in user's or merchant's id on the server; another party's session, transaction or receipt is a 404 (checked again by the new list/summary tests). Role guards on routes and in the UI. |
| Payment session / ticket lifecycle | Single-use, hashed, 120 s authorizations bound to (customer, session); amount always taken from the stored session; row-locked confirmation. Unchanged from Phase 5; covered by its 53 integration tests. |
| Biometric API responses | Raw face data is never returned. Authentication results include a match confidence and, behind "Technical details" in the UI, a distance; they never name anyone but the signed-in user. |
| Input validation | Pydantic schemas with `extra="forbid"` (the mass-assignment guard); length and pattern limits on the new list parameters; search text is escaped so `%` and `_` are literal. |
| SQL | SQLAlchemy Core/ORM with bound parameters only; no string-built SQL. |
| CORS | An explicit origin list from `CORS_ORIGINS`; only the headers and methods the app uses. (`allow_credentials` is on although the app uses bearer tokens, not cookies; harmless, left as is.) |
| Secrets | Read from the environment only. `.env` is git-ignored and excluded from backups. |
| Error messages | API errors carry a code and a message written for people. The frontend never displays a 5xx body and maps every status to a friendly sentence, so framework or stack-trace text cannot reach the screen. |

## Changed in Phase 6

* Every API response now carries `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`
  and `X-Frame-Options: DENY` (payment and biometric responses must not be cached).
* Requests that declare a body larger than `MAX_REQUEST_BYTES` (12 MB, enough for the largest legitimate face upload) get a
  413 before any parsing.
* `APP_ENV=production` refuses to start without `BIOMETRIC_KEY` or with the example `JWT_SECRET`, and turns off `/docs`,
  `/redoc` and `/openapi.json`.
* `DELETE /faces/samples` is now rate limited like the other face endpoints.
* The in-memory rate limiter drops idle clients, so its memory no longer grows with every address ever seen.
* Static security headers for the frontend host are in `frontend/vercel.json` (`nosniff`, `frame DENY`, no referrer,
  camera allowed for the site itself only).

## Remaining limitations

* **Liveness is basic.** A lateral head-movement challenge defeats a still photo; it does not defeat a video replay or a
  determined attacker. See `docs/face-authentication.md` for the measured open-set weakness (a stranger's face is accepted
  more often than a production system would allow).
* The body-size limit trusts the `Content-Length` header; a chunked request without one is not stopped by this check. A real
  deployment should also limit body size at its reverse proxy.
* Rate limiting is in memory and per process, keyed by the connecting address (behind a proxy that is the proxy's address
  unless forwarded headers are configured); several workers each count separately.
* Access tokens live in `localStorage`, so a cross-site-scripting bug would expose them. There are no refresh tokens, no
  server-side revocation, no email verification and no password reset.
* No Content-Security-Policy is set. The built app uses inline styles from its chart library, so a correct policy needs
  testing against the production build; it is left to deployment.
* Checkout links are bearer-style: any signed-in customer with the link can attempt to pay it (Phase 5 limitation).
* HTTPS is a deployment concern; the app does not enforce it. Browsers only allow camera access on HTTPS or localhost.
* Face samples are encrypted at rest with one application key (`BIOMETRIC_KEY`); there is no key rotation.
