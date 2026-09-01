---
status: In Progress
owner: @kushsharma024
last-verified: 2026-08-31
summary: The Google Play Data Safety form, filled out on paper — mirrors PrivacyInfo.xcprivacy's iOS mapping so Android carries the same enforced disclosure iOS already has.
---

# Google Play Data Safety mapping

iOS has an enforced privacy-manifest mapping:
[`PrivacyInfo.xcprivacy`](../apps/mobile/ios/LilypadMobile/PrivacyInfo.xcprivacy)
is checked against the backend schema by
[`iosBundle.test.ts`](../apps/mobile/src/lib/__tests__/iosBundle.test.ts), so
the declared data types cannot drift from what the code actually collects
without a test failing. Android ships to the Play internal track
(`mobile-android.yml`) with no equivalent — the Play Console's **Data safety**
form is filled in by a human, in a browser, from nothing.

This page is that mapping, worked out from the same sources the iOS one uses
— [`app-store-submission.md`](app-store-submission.md), the iOS privacy
manifest, and the backend schema — translated into Play's own vocabulary. It
is the thing to paste into App content → Data safety, not a replacement for
doing so: **the Play Console form itself still has to be filled in by hand**;
this page only makes that a transcription instead of a research project. This
document is not a test, and nothing in the repo asserts it against
`AndroidManifest.xml` or the backend schema the way `iosBundle.test.ts` does
for iOS — see the follow-up note at the bottom.

## Data collection table

Google's form groups data into named categories with a fixed purpose
vocabulary (`App functionality`, `Account management`, `Fraud prevention,
security, and compliance`, `Analytics`, `Personalization`, `Advertising or
marketing`, `Developer communications`). Every row below collects for
functionality/account reasons only — there is no analytics or advertising SDK
in the app, matching the iOS manifest's `NSPrivacyTracking = false`.

| Play data type                                              | Category            | Collected | Shared\* | Purpose                                    | Optional                                                                     | Encrypted in transit | User can request deletion                                            |
| ----------------------------------------------------------- | ------------------- | --------- | -------- | ------------------------------------------ | ---------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------- |
| Email address                                               | Personal info       | Yes       | No       | Account management, App functionality      | No — required to create an account                                           | Yes (HTTPS/WSS)      | Yes                                                                  |
| Name                                                        | Personal info       | Yes       | No       | Account management, App functionality      | Yes — only asked at password signup; OAuth and magic-link accounts have none | Yes                  | Yes                                                                  |
| Device or other IDs (device fingerprint, device name)       | Device or other IDs | Yes       | No       | App functionality, Account management      | No                                                                           | Yes                  | Yes                                                                  |
| Device or other IDs (IP address, sign-in security log only) | Device or other IDs | Yes       | No       | Fraud prevention, security, and compliance | No                                                                           | Yes                  | Automatic after 2 days; also cleared of the account link on deletion |

\* **"Shared" is No for every row, in Play's specific sense of the word.**
Play only counts data handed to a third party for _that party's own_
purposes as "shared". Oracle Cloud (hosting), Cloudflare (network), and Resend
(sign-in/reset email delivery) all process this data solely to run Lilypad on
our behalf and do nothing with it themselves — that is a service provider,
which Play's own definition excludes from "sharing". None of it is sold or
used for advertising, matching the privacy policy's own statement.

**Not collected, and worth saying explicitly because a remote-desktop app is
an obvious guess otherwise:** Location, Financial info, Health and fitness,
Messages, Photos/videos/audio/files, Contacts, Calendar, Web browsing history,
and any advertising or analytics identifier. There is no analytics SDK in the
bundle to collect any of it.

**Data deletion.** Play's form asks whether the app lets users request
deletion. Yes: the account screen deletes the account and everything under it
immediately and irreversibly
([`accountDeletion.ts`](../apps/backend/src/services/accountDeletion.ts)).
Access/export requests (distinct from deletion) go through
[`data-requests.md`](data-requests.md).

## AndroidManifest permissions

From
[`AndroidManifest.xml`](../apps/mobile/android/app/src/main/AndroidManifest.xml),
each permission and the one thing in the app that needs it:

| Permission                                   | Used for                                                                                                                                                                                                             |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CAMERA` (+ `uses-feature camera`)           | Scanning the pairing QR code shown on the desktop. Not used for anything else — no photo/video capture, no barcode scanning beyond the pairing flow.                                                                 |
| `INTERNET`                                   | Talking to the backend (sign-in, pairing, signaling) and, once paired, the desktop directly.                                                                                                                         |
| `ACCESS_NETWORK_STATE` / `ACCESS_WIFI_STATE` | Detecting whether a direct LAN path to the paired desktop is available, which is the fast, free, cloud-bypassing path the product prefers ([ADR-0006](adr/0006-lan-first-connectivity.md)).                          |
| `CHANGE_WIFI_MULTICAST_STATE`                | Holding a multicast lock so the app can send and receive mDNS packets — Android drops multicast traffic by default, and mDNS is how the app finds the desktop's advertised LAN address without a QR scan every time. |

No `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION`, no `READ_CONTACTS`, no
`RECORD_AUDIO`, no storage permission. `android:allowBackup="false"` — Android
auto-backup is off, so device keys and cached trust state never leave the
device through that channel.

## Follow-up (suggested, not done here)

**No automated check pins this page against the manifest or the schema.**
iOS has one because `PrivacyInfo.xcprivacy` is a bundle file the OS itself
reads and validates, so a test asserting its contents is asserting something
real. The Play Data Safety form is external — filled in through a web console
Lilypad's CI cannot reach — so there is nothing in this repo for a test to
check _against_ except this document itself, and a test that only checks this
page agrees with this page proves nothing. If a Play Data Safety export or
scraping mechanism becomes available, a parity test mirroring
`iosBundle.test.ts` (this table vs. `AndroidManifest.xml` vs. the backend
schema) would be the natural next step — flagged here rather than written,
since it would touch mobile/backend test files outside this pass's scope.
