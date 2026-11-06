# UPI-style layer (simulated)

Goal: make a FacePay payment read like the UPI payments people already know (a 12-digit reference, a step trail, and bank-side
outcomes), while everything stays a **simulation**: no bank is contacted, no balance exists, no real money moves, FacePay is not a
UPI app and is not connected to NPCI. The words "UPI" and "UTR" are used only as familiar names for a reference number.

## What is added
1. **Reference number.** Every transaction row, successful or failed, gets a random 12-digit reference (`utr`, unique). Existing
   rows are backfilled by the migration. It is shown on receipts and in activity detail, with a copy button.
2. **Step trail.** Computed when a receipt is read (never stored, never invented): face verified, you confirmed, your bank
   (simulated) debit, credit to the receiver (simulated), complete. Only the payer sees their own bank in the trail.
3. **Simulated bank outcomes.** Each demo bank account has a *demo behaviour*, set by its owner on the Banks page:
   works normally (default), declines payments, or does not respond. Behaviour is chosen by the user, never random, so a demo or a
   test is reproducible. A decline or timeout writes a FAILED transaction with its own reference, voids the face authorization
   (a failed attempt can never be replayed; the customer verifies their face again), returns the session to payable, and leaves any
   money request pending. The customer can retry, or pick another bank first.
4. **Limit and expiry outcomes** keep their existing server-side checks; the failure screens now say plainly what happened and what to do.

## Not added, on purpose
No balances, no wallet, no real bank, UPI, NPCI or payment-gateway call, no PENDING-then-resolve state (a timeout is shown as "did not
respond, no money moved (simulated)"), no PIN or credential entry for a bank.

## Integrity (unchanged)
Authorization stays single-use and 120 s; confirm still runs under the same row locks in the same order (session, request,
account); a session can still be paid once (unique index on SUCCESS per session); the amount comes from the session. The bank
failure path runs after every existing check, so it can only ever turn a would-be success into a recorded failure.

## Data
Migration `0011_upi_layer`: `transactions.utr` (varchar 12, unique, nullable for rows written by an older server during a deploy),
`transactions.failure_code` (varchar 30), `bank_connections.sim_behavior` (NORMAL | DECLINE | TIMEOUT, check constraint, default NORMAL).
Downgrade drops them.

## API
- `PATCH /banks/{connection_id}/behavior` `{ "behavior": "NORMAL" | "DECLINE" | "TIMEOUT" }`, the owner only.
- Receipt and activity detail gain `utr`, `failure_code`, `failure_message`, `trail`.
- `POST .../confirm` on a simulated bank failure answers 409 with `{code: BANK_DECLINED | BANK_TIMEOUT, message, transaction_id, utr}`.

## Risks
- A merchant sees failed attempts (payer name, amount, "Failed"); this matches real merchant dashboards. No bank detail is shown to them.
- The behaviour control is a demo switch. It must stay labelled as such so nobody mistakes it for real bank behaviour.
