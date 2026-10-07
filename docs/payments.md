# Simulated FacePay payments (Phase 5)

> Academic prototype. **No real money, UPI, bank, Razorpay or crypto.** Transactions are rows in PostgreSQL.
> Face authentication is the Phase 3/4 PCA-LDA pipeline and inherits its documented limits
> (`docs/face-authentication.md`): it is not bank-grade biometric security.

## Flow

```
Merchant creates session ──► Customer opens /checkout/<session_id> ──► "Pay with FacePay"
   ──► POST …/authenticate/start      (single-use liveness challenge, only if the session is payable)
   ──► POST …/authenticate            (frames → detection → PCA → LDA → classifier → liveness → policy → log)
         AUTHENTICATED ⇒ backend issues a one-time authorization bound to (this customer, this session)
   ──► POST …/confirm                 (authorization validated, consumed, transaction written: ONE database transaction)
   ──► receipt
```

The browser never says "authenticated". The only way to obtain an authorization is the `authenticate` call above,
where the backend itself makes the Phase 4 decision.

## Session lifecycle (`payment_sessions.status`)

| Stored | Brief's name | Meaning |
|---|---|---|
| `CREATED` | PENDING | Waiting for the customer |
| `AUTHENTICATED` | AUTHENTICATED | A live authorization exists |
| `PAID` | SUCCESS | Transaction written |
| `FAILED` | FAILED | 5 rejected face attempts (identity, liveness, confidence, distance, multiple faces) |
| `EXPIRED` | EXPIRED | Session time ran out (default 15 min, merchant chooses 1-60) |
| `CANCELLED` | CANCELLED | Merchant cancelled |

`PROCESSING` is not stored: validation, consumption and the insert are one atomic database transaction, so no
session can be observed "in processing". `AUTHENTICATED` falls back to `CREATED` when its authorization expires.
Time-based changes are applied when a session is read or written (no background job).
Camera problems (no face, blur, too small), a missing model and an expired challenge do **not** count toward `FAILED`.

## Authorization (`payment_authorizations`)

* 32-byte random bearer token, returned once; only its SHA-256 is stored. No biometric data, just a reference to the
  `authentication_logs` row of the successful attempt.
* Bound to `user_id` and `payment_session_id`; valid 120 s; single use (`ACTIVE → CONSUMED`); a new authentication
  revokes the previous one; cancelling/expiring/failing the session revokes it; one `ACTIVE` per (session, user) by
  a partial unique index.
* Confirm checks, in order: session payable → `expected_amount` (if sent) equals the stored amount → ticket exists,
  belongs to this customer and this session (unknown / foreign / other-session tickets all answer
  `AUTHORIZATION_INVALID`) → not used → not expired → linked log row is this customer's SUCCESS. The session row is
  locked (`SELECT … FOR UPDATE`) so concurrent confirmations are serialized, and a partial unique index allows only
  one `SUCCESS` transaction per session.
* The amount charged is always `payment_sessions.amount`. The confirm body accepts only `authorization_token` and
  `expected_amount`; any other field (e.g. `amount`) is a 422.

## API

Customer (`Bearer` customer token): `GET /payments/sessions/{id}`, `POST …/authenticate/start`,
`POST …/authenticate`, `POST …/confirm`, `GET /payments/transactions`, `GET /payments/transactions/{transaction_id}`.

Merchant (`Bearer` merchant token): `POST|GET /merchant/payment-sessions`, `GET /merchant/payment-sessions/{id}`,
`POST …/{id}/cancel`, `GET /merchant/transactions`, `GET /merchant/transactions/{transaction_id}`,
`GET /merchant/summary`.

Errors are `{"detail": {"code", "message"}}`: `SESSION_NOT_FOUND` (404; also for another merchant's session),
`SESSION_ALREADY_PAID|EXPIRED|CANCELLED|FAILED|NOT_CANCELLABLE`, `AMOUNT_MISMATCH` (409),
`AUTHORIZATION_INVALID|USED|EXPIRED` (403), `TRANSACTION_NOT_FOUND` (404), `RATE_LIMITED` (429).

## Data visibility

Customers see their own transactions and, for a checkout, the merchant's business name, order, amount and status
(no merchant email). Merchants see their own sessions/transactions and the payer's **name** (no email or id).

## Transactions

`FP-` + 10 random characters from a 32-character alphabet (no `I L O U`), unique-constrained. Deliberately not shaped
like a UPI reference. `payment_method = FACE_PAY`. Merchant summary: revenue = sum of `SUCCESS` transactions;
`failed_payments` = `FAILED` transactions + sessions that ended `FAILED`; daily series use India time (INR).

## Limitations
* The face check is only as strong as Phase 4 (see its limits). A payer who passes it can pay; there is no second factor.
* Anyone with a checkout link who is a signed-in customer can try to pay it; the session is not tied to a named
  customer. Sessions are unguessable (`ps_` + 128-bit token) but links are bearer-style.
* No refunds, balances, payouts, webhooks or idempotency keys; the in-memory rate limiters are per process.
* If the confirm response is lost after the server committed, a retry gets `SESSION_ALREADY_PAID` and the customer
  must check their history.
* Merchant status uses polling (3 s), not push.
