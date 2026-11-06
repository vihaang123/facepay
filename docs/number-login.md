# Mobile-number sign-in (simulated)

Goal: FacePay opens like the UPI apps people already know. You enter the mobile number linked to your bank, pick the bank, and
you are in. There is no email sign-up form any more. Everything remains a **simulation**: no SMS is sent, no bank or NPCI is
contacted, no balance exists, no real money moves.

## The flow
**Join:** mobile number → one-time code (demo) → name and 6-digit passcode → choose the bank the number is linked to (demo
connection) → set up your face (can be skipped and done later).
**Sign in:** mobile number + 6-digit passcode. One screen for customers, shops and the administrator; the server says which role
the number belongs to and the app opens the right area.
**Pay:** unchanged. A payment is confirmed with the face check, which stands in for the UPI PIN. Authorization is still
single-use and lasts 120 seconds.

## What the number is and is not
- A number belongs to exactly one account across customers, shops and the administrator. The `mobile_numbers` table has the
  number as its primary key, so two sign-ups racing for one number cannot both win (tested).
- The number is **not verified against anything**. Nothing checks that it is yours, or that it is linked to the bank you pick.
  The screens say so.

## The one-time code is a demo
FacePay has no SMS provider. The code is returned by the API and shown on screen, labelled "Demo code (no SMS is sent)". It
proves nothing about who holds the SIM, so it is **never what protects an account**. It only stops a typo and makes the flow
feel like the real thing. It is used once, at sign-up (and when an older account adds its number), never at sign-in, because a
code anyone can read on screen would add nothing to a sign-in.
- 6 digits, valid 5 minutes, 5 wrong tries then it is spent, single use, stored only as a keyed hash.
- At most 5 codes per number per 10 minutes, and 30 seconds between codes.
- `DEMO_OTP_ENABLED=false` switches the feature off: no code is ever returned and sign-up by number answers 503. That is the
  setting to use if a real SMS provider is ever added (the delivery step would replace the screen display).

## The passcode is what protects the account
- 6 digits, refused if it is a run (123456, 654321), all one digit, a repeated half, or on a short list of obvious guesses.
- Stored as an argon2 hash of an HMAC of (number + passcode) under the server secret. A copy of the database alone cannot be
  brute-forced offline; one leaked hash cannot be matched against another account's.
- A 6-digit passcode has only a million values, so safety comes from the **lock**: 5 wrong passcodes lock that number for 15
  minutes (`signin_attempts`). Unknown numbers lock the same way, and a wrong passcode and an unknown number return identical
  answers, so neither the lock nor the error reveals which numbers have accounts. Timing is evened out with a dummy hash check.
- Sign-in is also rate-limited per address like the other auth routes.
- **Risk accepted for a prototype:** someone who knows your number can lock you out for 15 minutes by guessing wrong. That is the
  price of a short passcode without SMS.
- **No recovery.** Forgot your passcode: not available in this prototype (said on the sign-in screen). Recovery would need a real
  second channel, which does not exist here.
- The passcode is not a bank PIN and nothing asks for one.

## Older (email) accounts
Nothing is lost. `/auth/login` and `/auth/merchant/login` still work (reached from "Older account? Sign in with email"). From
Profile an older account adds a mobile number (demo code + a passcode) and keeps its history, FacePay ID, face profile and banks.
One number per account; changing a number is not offered. Accounts made with a number have no email and no usable email password
(the column holds a random hash nobody knows).
Administrators: `python -m app.cli create-admin <email or 10-digit number>` (the account must exist).

## Data
Migration `0012_mobile_number_accounts`: `users.email` and `merchants.email` become optional; both gain `mobile` and
`passcode_hash`; new tables `mobile_numbers`, `otp_challenges`, `signin_attempts`. Nothing is deleted on upgrade. **Downgrade
refuses to run while any account has no email**, because making the column required again would delete those people's accounts.

## Not done, on purpose
Face as a second step at sign-in (possible later; the face check's liveness is not strong enough to be a login on its own), SMS,
real UPI, passcode recovery, changing a number, email sign-up.
