---
status: Implemented
owner: @kushsharma024
last-verified: 2026-08-31
summary: How a GDPR/CCPA data access or export request is handled today — an operator runbook, since export has no in-app button yet.
---

# Data access and export requests

Deletion is self-serve: [privacy.html](../apps/site/privacy.html) says the
account screen deletes everything outright, and
[`accountDeletion.ts`](../apps/backend/src/services/accountDeletion.ts) is what
runs when someone taps it. **Access and export are not** — there is no
in-app "download my data" button, so a request for one lands as email and is
worked by hand. This page is that hand-worked process, written down so it does
not depend on one person remembering the steps.

## 1. How a request arrives

**support@takedia.com.** The same address the privacy policy, the terms, and
`SECURITY.md` already publish for "a request to see or delete your data". No
separate form or portal exists, and none is needed at this account count.

## 2. Verifying who is asking

**Standard: the request must come from the address on the account.** Lilypad
has one identity per account (`users.email`), so a reply sent from that same
inbox is proof of access to it, which is the same bar the magic-link and
password-reset flows already sit at. Concretely:

- If the email arrives from the address on file, that is sufficient.
- If it arrives from a different address ("I can't get into that inbox
  anymore"), ask the requester to send it from the account address instead.
  There is no fallback identity check to run past that — a one-person support
  desk with no ticketing system should not improvise a weaker one under
  pressure. If the account address is genuinely unreachable, this becomes an
  account-recovery conversation, not an access request.
- Never send account contents to an address that is not the one on file, even
  if it looks like a very plausible request from a different address.

## 3. What data exists, and where

Everything below is Postgres, per [db-schema.md](db-schema.md). Nothing about
a session — the screen, the input, the clipboard — is ever stored anywhere;
that is an architectural constraint
([ADR-0007](adr/0007-cloud-is-control-plane-only.md)), not a policy promise,
and there is no table it could be sitting in.

| What                                   | Table             | Fields worth exporting                                                                                                                                                                                              |
| -------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account                                | `users`           | email, name (if set), whether a password is set (never the hash or the password itself), which OAuth providers are linked, subscription/entitlement state if a Pro purchase is linked, when the account was created |
| Devices                                | `devices`         | name, platform, app version, when each was added and last seen, whether revoked                                                                                                                                     |
| Pairings                               | `trusted_devices` | which desktop/mobile pairs exist, when each last connected, whether revoked                                                                                                                                         |
| Sessions (account, not remote-control) | `refresh_tokens`  | that a session exists, when it was created/expires, whether it was revoked — the token itself is never stored, only a hash                                                                                          |
| Sign-in security log                   | `audit_logs`      | sign-ins, failed sign-ins, device changes, and the IP address they came from — only the rows still inside the 2-day window (see below)                                                                              |

Two things worth being explicit about, because they are the two ways this
table could quietly overclaim:

- **The 2-day sign-in security log means a request may turn up nothing there.**
  `audit_logs` rows older than 48 hours are already gone by the time a request
  is answered
  ([`auditRetention.ts`](../apps/backend/src/services/auditRetention.ts)). An
  export that only ever shows the last day or two of sign-in activity is
  correct, not incomplete.
- **Backups are not a source for this.** They exist to restore the whole
  database after a failure, are kept 7 days, and are not queried for one
  person's data — fulfilling a request always reads the live database, never
  a backup. A backup taken before a deletion can still contain the deleted
  data until it ages out, which is stated on the privacy page and is the
  reason deletion, not export, is the operation that actually removes
  something.

## 4. Fulfilling a request

1. **Confirm identity** per §2 before running anything.
2. **Look up the account** by email:

   ```sql
   select id, email, name, tier, created_at,
          (password_hash is not null) as has_password
     from users where email = '<address>';
   ```

3. **Pull the rest of the tables using that `id`:**

   ```sql
   -- devices
   select name, platform, app_version, created_at, last_seen_at, revoked_at
     from devices where user_id = '<id>';

   -- oauth identities (which providers, not what they returned)
   select provider, created_at from oauth_identities where user_id = '<id>';

   -- pairings — trusted_devices has no user_id (see db-schema.md), so join
   -- through the account's own device ids from the query above
   select display_name, created_at, last_connected_at, revoked_at
     from trusted_devices
    where desktop_device_id in (<device ids>) or mobile_device_id in (<device ids>);

   -- account sessions (metadata only — the token itself was never stored)
   select created_at, expires_at, revoked_at from refresh_tokens where user_id = '<id>';

   -- sign-in security log — whatever is still inside the 2-day window
   select event_type, ip, created_at from audit_logs
    where user_id = '<id>' order by created_at desc;
   ```

4. **Compile a plain-text or JSON summary** of the rows above. Do not include
   internal database ids, password hashes, or refresh-token hashes — those
   are not "your data" in the sense the request means, they are how the
   system enforces access to it, and handing them out helps nobody.
5. **Send it to the verified account address**, not to whichever address the
   request arrived from if the two differ (see §2).
6. **Note the fulfillment** — date, what was sent — in whatever the operator
   keeps for this (today: the email thread itself, since there is no ticketing
   system). That note is the only record that the request was answered.

## 5. Response-time targets

| Regime | Statutory ceiling                                                                | Internal target |
| ------ | -------------------------------------------------------------------------------- | --------------- |
| GDPR   | One month (Article 12(3)), extendable by two further months for complex requests | **7 days**      |
| CCPA   | 45 days, extendable once by 45 more                                              | **7 days**      |

The internal target is far inside either statutory ceiling on purpose. The
whole dataset for one account is five small tables and a query away — the
work in §4 takes minutes, not weeks — so a 30/45-day target would only be
honest about _company size_, not about how long this actually takes. Being
run by one person is a reason to be slower to notice a request, not slower to
answer one once it's found; if support volume ever makes 7 days unrealistic,
that is the trigger to build the in-app export button rather than to relax
this number.

## What this document does not cover

- **Deletion** — already self-serve; see the account screen and
  [`accountDeletion.ts`](../apps/backend/src/services/accountDeletion.ts).
- **The actual export format** — there is no generated file today, only the
  summary in §4. A structured (JSON) export is the natural next step if
  request volume ever justifies building one.
