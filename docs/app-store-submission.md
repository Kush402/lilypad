---
status: In Progress
owner: @kushsharma024
last-verified: 2026-08-26
summary: What App Review is told, what the encryption declaration rests on, and the metadata to paste — the three things a submission needs that live in no other file.
---

# Submitting Lilypad to the App Store

Three things a submission needs that are neither code nor App Store Connect
settings: the notes a reviewer reads before they open the app, the reasoning
behind the export-compliance answer, and the store copy. They live here because
each one is a decision with a defence, and a decision whose defence is not
written down gets re-litigated by whoever submits next.

Covers items **A4**, **A8** and **A9** of the launch audit. **A2** (purchase
path) is now wired in code against product
`com.takedia.lilypad.pro.monthly` — see [ADR-0016](adr/0016-storekit-and-the-price.md)
and `POST /billing/apple/transactions`. The remaining App Store Connect metadata
for that subscription (review screenshot, Ready to Submit) is still a portal
step, not a code one.

---

## 1. Review notes

Paste into **App Store Connect → the version → App Review Information →
Notes**. Every submission, not only the first: notes do not carry forward, and
the 4.2.7 paragraph is the reason this app gets approved rather than argued
about.

> Lilypad lets someone use their own Mac from their own iPhone. The Mac runs a
> companion app the customer installs themselves from lilypadhome.takedia.com.
>
> **On guideline 4.2.7.** Lilypad is a **generic mirror of the customer's own
> host device**: it streams that Mac's whole screen and returns keyboard,
> trackpad and scroll input. It is not a mirror of specific software or
> services, so the conditions in 4.2.7 do not attach to it. This is the same
> category as TeamViewer, Chrome Remote Desktop, Jump Desktop and Screens, all
> of which operate over the internet as well as over a local network.
>
> **What the app does not do.** It renders no store, sells nothing on the host's
> behalf, and offers no way to browse, select or acquire software. It cannot
> connect to any machine except one the customer has physically paired by
> scanning a code shown on that machine's screen.
>
> **Permissions.** The camera is used only to scan that pairing code. The local
> network permission is used to reach the Mac directly when both devices are on
> the same Wi-Fi, which is the fastest and most private path and the one the app
> prefers.
>
> **The AI feature ("Ask")** is off until the customer turns it on. The app
> explains, before the first use, that the Mac's screen contents are sent to the
> AI provider the customer configured on that Mac (Anthropic or OpenAI) under
> their own API key, and asks permission. Declining leaves every other feature
> working, and permission can be withdrawn from the same panel.

### Why the 4.2.7 paragraph exists

The guideline reads:

> "**If your remote desktop app acts as a mirror of specific software or
> services rather than a generic mirror of the host device**, it must comply
> with the following: (a) The app must only connect to a user-owned host device
> that is a personal computer… and **both the host device and client must be
> connected on a local and LAN-based network**."

The LAN restriction is conditional on that opening clause. It binds apps that
mirror _specific software_ — a game, one cloud application — and not generic
mirrors of a whole computer. Lilypad is the latter.

The risk this paragraph manages is not the rule, it is the reading: a reviewer
who meets "control your Mac from anywhere" and then finds 4.2.7(a) can reject on
the sentence rather than the paragraph. Getting that reversed costs an appeal
cycle, and stating it up front costs nothing.

---

## 2. Export compliance

**Answer: `ITSAppUsesNonExemptEncryption` is `false`, and here is what that
rests on.** The value has been in `Info.plist` since before anyone checked it;
this section is the check.

The question Apple asks is not "does your app encrypt things" but "does it use
encryption that is **not exempt**". Lilypad encrypts in three places:

| Where            | What                          | Why it is exempt                                                                                |
| ---------------- | ----------------------------- | ----------------------------------------------------------------------------------------------- |
| Media and input  | DTLS-SRTP, via WebRTC         | Standard, published protocol; the encryption is a means to an end, not a feature of the product |
| Device identity  | Ed25519 signatures (ADR-0002) | Authentication and digital signature only. No confidentiality; signing is separately exempt     |
| Everything to us | HTTPS / WSS                   | Standard TLS to our own control plane                                                           |

All three fall inside the exemption for standard, published cryptography used
for authentication or for a protocol Lilypad neither invented nor modified.
Lilypad implements no cryptographic algorithm of its own, offers no encryption
as a user-facing feature, and lets nobody choose or supply a cipher.

**Two caveats, recorded rather than smoothed over.** Lilypad bundles its own
WebRTC rather than calling an Apple framework, so the narrowest reading of the
"encryption provided by the operating system" exemption does not apply — the
claim above rests on the standard-algorithm branch, not that one. And this is an
export-control declaration, not an App Store preference: a wrong answer is a
matter for the Bureau of Industry and Security, and France requires a
declaration of its own for encryption distributed there.

**If the product ever encrypts something for its own sake** — end-to-end
encrypted file transfer, a customer-supplied key, stored ciphertext — this
answer stops being true and must be redone before that version ships.

---

## 3. Store metadata

Copy to paste, so the store listing says the same thing as the product.

**Name.** Lilypad
**Subtitle** (30 char max). Your Mac, from your phone.
**Category.** Primary: Productivity. Secondary: Utilities.
**Age rating.** 4+. No user-generated content, no ads, no third-party links out.

**Promotional text** (170 max, changeable without review):

> Free on your own Wi-Fi, forever. See your Mac's screen, use its trackpad and
> keyboard, and pick up where you left off.

**Description:**

> Lilypad turns your iPhone into a window onto your own Mac.
>
> See the screen. Use the trackpad and keyboard. Open the thing you left open.
> Your Mac stays where it is; you do not have to.
>
> **Free on your own network, forever.** When your phone and your Mac are on the
> same Wi-Fi, the connection goes straight between them. Nothing passes through
> our servers, nothing is metered, and nothing is counted. That is not a trial
> tier. It is how the product works.
>
> **Pair once, with a code you can see.** Setup shows a code on your Mac's
> screen and you scan it with your phone. Nothing can reach your Mac without
> that step having happened in person, which is the point.
>
> **You are asked before anything starts.** A session begins when someone at the
> Mac says yes. That is not a setting.
>
> **Ask (optional).** Describe what you want done and let an assistant do it on
> your Mac. It is off until you turn it on, it tells you what leaves your
> machine before anything does, and it asks before anything consequential.
>
> Lilypad needs the Mac companion app, free from lilypadhome.takedia.com.
> Requires macOS 12.3 or later.

**Keywords** (100 char max, comma-separated, no spaces):

> remote,desktop,mac,screen,control,trackpad,keyboard,vnc,remote desktop,screen share

**Support URL.** https://lilypadhome.takedia.com/#faq
**Marketing URL.** https://lilypadhome.takedia.com
**Privacy Policy URL.** https://lilypadhome.takedia.com/privacy.html

### Screenshots

Required for the 6.9" iPhone; the 6.5" set is inherited if not supplied. Take
them against a real Mac, not a mockup: the product is credible or it is nothing,
and a fake desktop looks fake.

1. The Mac's screen live on the phone, in landscape, with something recognisable
   open on it.
2. The device list, showing a paired Mac by name.
3. The pairing moment: the Mac's screen holding the code, the phone about to
   scan it.
4. The approve prompt on the Mac, because "someone has to say yes" is the
   sentence that sells this to a cautious person.
5. Ask, mid-task, with the approval card visible.

**An app preview video matters more here than the stills.** Remote control is
motion, and no still frame conveys that the trackpad is live. It also doubles as
evidence for App Review that the product works end to end.

---

## 4. Before pressing submit

- [ ] Sign in with Apple tapped on a real device, not the simulator (**A7**).
- [ ] `PrivacyInfo.xcprivacy` and the App Privacy answers in App Store Connect
      say the same thing. A mismatch is its own rejection.
- [ ] Account deletion reachable from inside the app (it is, via the account
      screen, and 5.1.1(v) requires it to stay that way).
- [ ] Support URL and Privacy Policy URL both resolve, anonymously, in a private
      window.
- [ ] Review notes above pasted into this version.
- [ ] Enrolled in the App Store Small Business Program. It is not automatic, and
      it is the difference between 15% and 30%.
