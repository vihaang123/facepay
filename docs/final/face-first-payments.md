# Face-first payments

*Pay with your face. Confirm with confidence.*

This release turns the UPI-style interface into a face-first payment experience. It changes **what is paid, from where and
how it is shown**. It does not change how a face is recognised (see "What did not change").

Everything is a demonstration. No real bank account is accessed, no bank credential of any kind is asked for or stored,
and no money moves. Every bank screen says so: *"Demo connection only. No real bank account is accessed and no money is
transferred."*

## The flow

1. A payment starts from something FacePay can trust: a **merchant payment request or link**, a **known recipient the
   customer picked by FacePay ID**, a **QR code**, or the simulated **FacePay nearby (demo)** list.
2. The recipient and the amount come from that request or from the customer's explicit choice, never from the face.
3. The customer reviews who and how much, then verifies their face (face detection, identity, basic liveness: unchanged).
4. The confirmation screen shows the recipient or merchant, FacePay ID, amount, description, the **funding source**
   (their own demo bank account, changeable here), a simulated fee, the total and the authentication status.
5. Nothing is paid until the customer presses **Confirm and Pay ₹X**. **Cancel** voids the face authorization and pays nothing.
6. The server creates one transaction and a receipt. The receipt and the activity history name the funding source.

FacePay never pays automatically after recognising a face, and it never infers a recipient from a face.

## Customer home

The face-first action ("Pay with Face") is the most prominent element. Below it: Pay a person, Pay a merchant, Payment
requests, FacePay nearby (demo), recent payments, connected bank accounts, FacePay ID and profile. There is no wallet
balance, top-up or balance-based flow any more.

## Connected bank accounts (simulated)

A customer picks a bank (the 12 required banks plus Federal Bank, Bank of India and Indian Bank), sees a clearly labelled
**simulated connection** step, picks a **demo account profile** (savings, current, salary) and FacePay creates a
`bank_connections` record: bank name, masked reference such as `DEMO-••••-4821`, account type, status and a default flag.

* Up to five live accounts; the first becomes the default; the default can be changed; accounts can be disconnected.
* Disconnecting is a soft delete: past transactions keep showing their original funding source.
* The client sends only a bank **code** and an account type. The bank name, reference and status are created by the server.
* FacePay shows no balance for a linked bank and never treats a link as proof of funds.
* Bank logos are not used. The monogram badges are neutral.

## Merchant side

Merchants create a request (amount, order reference, expiry, unique session id) and get a secure payment link and QR code.
They can show a request in the simulated nearby list, hide it again, cancel it and watch its status:
awaiting payment, authenticated, paid, cancelled, expired or failed. A request is **Paid only when the backend has
recorded a successful transaction for it**; the page never shows paid on its own. A reconciliation view lists requests
against the transactions that settled them (and counts any mismatch, which should always be zero). Merchant analytics stay
separate from the administrator's PCA and LDA analysis.

## FacePay nearby (demo)

This is a **simulation**. It lists open merchant requests that merchants chose to display. It uses no location, no Bluetooth
and no automatic merchant detection, and says so on screen. Opening an entry is an ordinary checkout.

## API changes

| Method and path | Purpose |
|---|---|
| `GET /banks/catalog`, `GET /banks`, `POST /banks`, `POST /banks/{id}/default`, `DELETE /banks/{id}` | Demo bank connections (customer only, scoped to the caller) |
| `GET /payments/sessions/{id}` | Now includes `fee`, `total` and the caller's own `funding_sources` (no balance) |
| `POST /payments/sessions/{id}/confirm` | Accepts an optional `funding_source_id`; the server checks it belongs to the caller and is live |
| `POST /payments/sessions/{id}/authorization/cancel` | Cancel at confirmation: voids the live authorization, pays nothing |
| `GET /payments/nearby` | Simulated discovery of displayed merchant requests |
| `POST /merchant/payment-sessions/{id}/display` | Show or hide a request in the nearby demo |
| `GET /merchant/reconciliation` | Requests against confirmed transactions |
| removed: `GET /wallet` | There is no wallet |

## Database changes (migration 0008, additive)

* New table `bank_connections` (owner, bank code and name, account type, last four digits of the demo reference, default
  flag, status, timestamps) with checks and two partial unique indexes: one default per customer, one live connection per
  customer, bank and account type.
* `transactions`: `funding_source_id`, `funding_bank_name`, `funding_account_ref` (a snapshot, so history survives a disconnect).
* `payment_sessions`: `discoverable`.
* The old `users.balance`, `merchants.balance` and `ledger_entries` stay for history and for the integrity check
  (`ledger_service.reconcile`). Nothing writes them any more and new customers start with no balance.
* `alembic downgrade 0007` removes only what 0008 added.

## Security rules enforced on the server

* A customer can read, change and use only their own bank connections. Another customer's connection looks like a missing one.
* The amount, the recipient, the merchant and the expiry are read from the database; the confirm request must match what the
  authorization was issued for. A client-supplied amount, bank name, bank id or status is never trusted.
* The funding source is locked and re-checked inside the same database transaction that creates the payment, so it cannot be
  disconnected mid-payment.
* The face authorization is bound to one customer and one payment, works once and expires in two minutes. Replaying a
  confirmation returns the original result and creates no second transaction.
* Confirming with no usable bank account is refused (`NO_FUNDING_SOURCE`, `FUNDING_SOURCE_INVALID`) and moves nothing.
* An expired, cancelled or already-paid request cannot be paid.

## What did not change

Face detection and preprocessing, PCA, LDA, the classifier, recognition thresholds, enrollment requirements, liveness,
biometric authorization security, model training and inference, and their tests are untouched. The only payment-code change
that touches authorization is that confirmation now also records a funding source and the customer can void an unused
authorization. Face authentication still happens in `payment_service.authenticate_for_payment`, exactly as before.

## Limitations

* Bank connections are records, not integrations. There is no real bank, UPI, card network or account aggregation.
* There are no balances, so FacePay cannot decline a payment for insufficient funds (a real system would).
* The nearby list is a simulation of discovery, not proximity.
* The fee is a simulated constant (zero).
* The liveness check is basic; the prototype is not hardened against deepfakes or replayed video.
