# Automatic bank account discovery (simulated)

After a customer picks a bank, FacePay finds the account for them. Nobody types an account holder name, account type, branch or
account number. **This is a simulation.** No bank, UPI network or NPCI is contacted, and the screens say so.

## The flow
1. Join with a verified mobile number (see [number-login.md](number-login.md)).
2. Choose a bank.
3. Press "Find and link my account". Only the bank code is sent.
4. The server asks the configured discovery provider for the customer's account at that bank.
5. The returned record is validated and stored with the link.
6. The confirmation screen shows what the server returned: bank, account holder, masked account number, account type, IFSC and
   branch (when the provider returned them), linking status, and whether it is the default account.
The same details are shown on the Banks page, and read back from the database after every login and restart.

## Provider interface (`app/services/bank_discovery.py`)
`BankDiscoveryProvider.discover(DiscoveryRequest) -> list[DiscoveredAccount]` is the whole contract. The request carries the
customer id, the bank, the verified mobile number (the key a real UPI lookup would use) and the customer's registered name (used
only by the simulator). The answer carries holder name, account type, last four digits, and optional IFSC and branch.
- A field the provider does not return is `None`, stored as empty and **not shown**. Nothing is filled in.
- A malformed record is refused (503, nothing linked), not patched up.
- An unknown or unconfigured provider name fails visibly (503) and never falls back to made-up data.
- Failures answer "Nothing was linked" and store nothing; "no account at that bank" is a 404.
To add a real, authorised bank or UPI account-discovery integration: implement the interface, `register_provider("name", ...)`,
set `BANK_DISCOVERY_PROVIDER=name`. The API, storage and screens do not change. Real consent, licensing and the provider's own
security obligations are outside this prototype and are not claimed.

## The simulator
Deterministic: computed from (customer id, bank) with a hash, nothing random or time based, so the same customer gets the same
account on every login, after every restart and after unlinking and relinking. The holder name is the customer's registered name
in capitals, produced by the simulated record (the client never supplies it). The IFSC starts `DEMO0` and the branch starts
`Demo Branch`, so neither can be mistaken for a real one. The account number is shown as `DEMO-••••-1234`.
One account per customer per bank; a customer can link up to five.

## Security
- Scoped to the signed-in customer on every call. Another customer's link answers exactly as one that does not exist (404).
- The request accepts only `bank_code`. A holder name, IFSC, branch, account type, account number, password, UPI PIN, card
  number, Aadhaar number or OTP in the request is refused (422, tested). No such value is requested, stored or logged.
- A payer's account details are never part of what the recipient sees (tested).
- The holder name is stored when linked. Changing the profile name later does not rewrite a linked account.

## Data
Migration `0013_bank_discovery`: `bank_connections.holder_name`, `ifsc`, `branch`, `discovery_source` (and an IFSC format check).
Links made before this change get the holder name the simulated record would show; their IFSC and branch stay empty. The customer
no longer picks an account type: the provider reports it (`account_types` is gone from the catalog and the request).
