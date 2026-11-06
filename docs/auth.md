# Authentication

> **Sign-in is now by mobile number and a 6-digit passcode** (see [number-login.md](number-login.md)). The email and password endpoints below are kept for accounts made before that change; the app reaches them from "Older account? Sign in with email", and the sign-up form for them is gone.

## Accounts

Customers live in `users`, merchants in `merchants`. They are separate tables, so the same email can register as both. Each login endpoint only checks its own table.

## Passwords

- Hashed with **Argon2id** (`argon2-cffi`, library defaults). Salted per password; plaintext is never stored or logged.
- Rules: 8 to 128 characters, at least one letter and one number. Enforced on the server (and mirrored in the UI for fast feedback).
- Login never reveals whether an email exists: unknown email and wrong password return the same `401` body, and a dummy hash is verified for unknown emails so timing is similar.
- Hashes are upgraded automatically at login if the Argon2 parameters change.

## Tokens

- JWT (HS256) signed with `JWT_SECRET` from the environment (minimum 16 characters, app refuses to start otherwise).
- Claims: `sub` (id), `role` (`customer`, `admin` or `merchant`), `type=access`, `iat`, `exp`. Default lifetime 60 minutes (`JWT_EXPIRE_MINUTES`).
- Decoding pins the algorithm and requires `exp`, `sub`, `role`. Tampered, expired, wrong-secret, `alg: none` and wrong-type tokens are rejected (all covered by tests).
- Every protected request re-reads the account from the database, so deleting or disabling an account takes effect immediately even for unexpired tokens.
- Role separation: merchant tokens get `403` on customer routes and vice versa.

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/auth/register` | none | Register a customer (older API; the app no longer uses it) |
| POST | `/auth/login` | none | Customer login, returns token |
| POST | `/auth/merchant/register` | none | Register a merchant (older API; the app no longer uses it) |
| POST | `/auth/merchant/login` | none | Merchant login, returns token |
| POST | `/auth/number/otp` | none | Ask for a demo one-time code for a number |
| POST | `/auth/number/verify` | none | Check the demo code |
| POST | `/auth/number/signup` | none | Create a customer or shop account from a verified code; returns a token |
| POST | `/auth/number/signin` | none | Number + passcode; returns a token with the account's role |
| POST | `/auth/number/claim` | customer or shop | An older account adds its number |
| GET | `/users/me` | customer | Read profile |
| PATCH | `/users/me` | customer | Update `name`, `phone` only |
| GET | `/merchants/me` | merchant | Read profile |
| PATCH | `/merchants/me` | merchant | Update `name`, `business_name` only |
| GET | `/health` | none | Liveness + database check |

Profile updates reject unknown fields (`email`, `role`, `status`, `password_hash`, `id` all return `422`). There is no password-change endpoint yet.

## Other protections

- **Rate limiting:** 10 requests per minute per IP per auth endpoint (`AUTH_RATE_LIMIT_PER_MINUTE`), then `429` with `Retry-After`.
- **Validation errors** return only `type`, `loc` and `msg`; submitted values (including rejected passwords) are never echoed back.
- **CORS:** explicit origin allow-list, no wildcard.

## Frontend

`AuthProvider` holds `{status, token, role, profile}`. A stored session starts as `loading` and is validated by fetching the profile; any authenticated request that returns `401` logs the user out. `ProtectedRoute` guards by role and `GuestRoute` redirects signed-in users away from login pages.

## Known limitations (prototype)

- **Logout is client-side.** Tokens are stateless, so a copied token stays valid until it expires. A token denylist or refresh-token rotation would fix this.
- **Token in `localStorage`** is readable by any script on the page (XSS). Production would use httpOnly cookies.
- **Rate limiter is in-memory:** per process, resets on restart, and behind a reverse proxy it sees the proxy's IP unless forwarded headers are configured.
- **Registration reveals whether an email is taken** (`409`). That is a usability trade-off; it also means email enumeration is possible, which the rate limit only slows down.
- No email verification, password reset, account lockout or MFA.
