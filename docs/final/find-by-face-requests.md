# Find a customer by face, and ask them for money

Added after the face-first payments work (migration `0009`). A shop, or another customer, points the **rear camera** at a
FacePay customer, sees their name and a masked FacePay ID, and sends them a payment request. The customer gets it as a
pop-up, checks the amount, purpose and reference, verifies their own face and confirms. Everything is simulated: no real
money moves and no real bank is involved.

## The flow

1. The customer has switched on **Security > Let shops and friends find me by face**. It is **off for everyone** until they do.
2. The requester (a shop, or a customer on *Request money*) opens the rear camera and presses **Scan face**.
   Three still frames are sent to `POST /face-lookup`. No video, no picture is stored.
3. The server answers with the person's **name and masked FacePay ID** and a **single-use scan ticket** (3 minutes). If
   nobody matches, the answer is a plain "no FacePay customer found" and never says whether a face belongs to someone
   who has not opted in.
4. The requester confirms "is this who you meant?", then enters the **amount, a purpose and a reference**. All three are required.
5. The request is created for exactly that customer (`POST /requests` with `lookup_token`, or
   `POST /merchant/payment-sessions/by-face` for a shop). The ticket is spent only if the request is saved.
6. The customer's open app shows a **pop-up** (it checks `GET /requests/incoming/prompts` every 5 seconds):
   who, how much, what for, the reference, and a warning that FacePay never asks for OTPs or PINs.
   **Review and pay** starts the normal payment; **Decline** closes it; **Not now** hides it for the session.
7. The normal payment follows, unchanged: face check with a liveness challenge, single-use authorization (120 s),
   explicit **Confirm and Pay** with the chosen demo bank account, one transaction, receipt.

## Purpose and reference (anti-scam)

Every request to another customer, by face or by FacePay ID, needs:

* a **purpose** from a fixed list (goods or shopping, service or work done, splitting a bill, repaying money lent,
  rent or deposit, something else), and
* a **reference** of 3 to 80 characters that reads like a reason (at least three letters, not one repeated character).

References that match common scam scripts (OTP, CVV, UPI or ATM PIN, password, lottery, prize, gift card, crypto,
KYC update and a few more) are refused. This is a guard rail for a prototype, not fraud detection. The server checks
everything; the screens repeat the checks only so people see the problem before sending.

## How recognition is used (nothing in it was changed)

Payment authentication is *verification* ("is this person who they say they are?"). Finding someone is *identification*
("who is this?"). `app/services/face_lookup_service.py` reads the trained model and the stored profiles and applies the same
rule as payment authentication through the same `auth_policy.decide`: same preprocessing, same PCA -> LDA -> classifier,
same confidence floor, mean distance within the person's own threshold and the per-frame cap. At least two usable frames
must agree on the same person. Liveness is not part of it, because finding someone pays nothing. No file under
`app/ml/` was modified, and no threshold was changed.

## Safeguards

| Risk | What stops it |
| --- | --- |
| Anyone can be identified from a camera | Only customers who opted in can be found. Off by default, including for existing customers |
| A stranger's face is misidentified | The person found must still approve with their **own live face check** and confirm. A wrong match can only cause a request to be declined |
| Scanning people in bulk | 8 scans per minute per requester; one face at a time (a second face in view is refused) |
| Learning someone's identity | A match shows a name and a masked ID only. The full FacePay ID is not returned |
| Being scanned without knowing | Each match is written to the person's security log ("Someone found you by face scan") |
| Replaying a scan | The ticket is single use, tied to the requester, expires in 3 minutes, and only its hash is stored |
| Scam requests | Purpose and reference are required and checked; the pop-up repeats a warning |
| A shop request reaching the wrong person | It is addressed to one customer. Others get "not found" if they open it, and it never appears in the nearby list |

## Limits to say out loud

* Recognition accuracy was measured on the public ORL dataset, not on real phone cameras. Identifying one person out of
  several is harder than verifying one person, so a wrong match is possible. The approval step by the person asked is
  the real protection.
* The pop-up works while FacePay is open in a browser tab. It is not a push notification and nothing can reach a closed
  app. Real push needs a push service and a native app or installed web app, which this prototype does not have.
* Any registered shop can scan; there is no business verification. A real service would verify merchants.
* The rear camera is used where the device has one. A laptop with one webcam falls back to that webcam.
* Liveness is basic (a head-turn challenge); a video replay is a known limit.

## Tests

`backend/tests/test_face_lookup.py` (45 tests): opt-in, no leakage when not opted in, name and masked ID only, own face,
strangers, camera problems, ticket single use / ownership / expiry / opt-out after scan, a failed request does not spend the
ticket, required purpose and reference, the incoming feed, approving with the right face and refusing the wrong one,
the shop route, declining, rate limit, disabled accounts. Frontend: `frontend/src/pages/lookup.test.jsx`.
