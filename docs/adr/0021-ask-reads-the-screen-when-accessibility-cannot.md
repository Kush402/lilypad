---
status: Reference
owner: @kushsharma024
last-verified: 2026-09-21
summary: When the app in front exposes no controls through accessibility, the Mac reads the words on the screen itself with the Vision framework and offers those as things to click. The picture never leaves the Mac; what leaves is short names, filtered to what reads like a label and never taken from a field.
---

# ADR-0021 — Ask reads the screen when accessibility cannot

## Status

Superseded in part by
[ADR-0022](0022-hosted-ocr-is-local-targeting.md) — 2026-09-21. The local
Vision fallback remains accepted; its outbound-data and target-staleness rules
are replaced. Extends
[ADR-0020](0020-lilypad-runs-computer-use-on-its-own-account.md) by adding one
source of elements, and does not change what that decision refuses. It moves
`AI_CONSENT_POLICY` to 4.

## Context

ADR-0020 chose a model that is never sent a picture. That makes the
accessibility reading the whole input to a hosted task, and it means the
reading failing is the task failing.

It fails often, and not only in edge cases:

- the focused window is on a display the session is not sharing, or nothing is
  focused at all — both are what the owner hit on v0.1.48, and both end the
  run (L-369 made them say which one);
- the app in front exposes nothing an agent can act on: an Electron window
  that never enabled accessibility, a canvas, a game, a remote desktop, a
  screen shared from another machine;
- the controls are there but unnamed, which is every icon-only toolbar.

The reference implementation of this same loop
([fka.dev, 2026-09-19](https://blog.fka.dev/blog/2026-09-19-implementing-computer-use-using-jev-on-macos/),
and `jcpsimmons/jev-macos-loop`) does not have this failure, because
accessibility is not its eye. It detects controls in the pixels, reads their
text with Apple's Vision framework, and uses accessibility only to enrich what
it already saw. Everything stays on the Mac; only text goes to the model.

**Measured here, 2026-09-21**, reading this Mac's own 2880×1800 screen with
`VNRecognizeTextRequest` at the accurate level: 136 runs of words, including
the labels a person would click. Encoding the frame as PNG cost 3.9 s — four
times the recognizer itself — against 1.7 s as JPEG at quality 92, for the same
136 runs. What it also read was the contents of an open `package.json`, which
is the whole of the risk in one example.

In a release build, the same screen: **0.46 s to capture, 0.09 s to encode,
2.1 s to recognize**. That is the price of one look, and it is why this is a
fallback and not a second eye on every step.

## Decision

1. **Accessibility stays first.** Where it lists anything that can be acted
   on, nothing changes and nothing is captured: no Screen Recording grant is
   needed and no second cost is paid.
2. **Where it lists nothing, the Mac reads the screen itself** — captures the
   shared display, runs the Vision framework locally, and offers the words it
   finds as things to click. Only for a model that is never sent a picture; a
   model that can see already has one.
3. **The picture never leaves the Mac**, exactly as before. ADR-0020's promise
   was "no screenshot ever leaves", and that is unchanged. What is no longer
   true is its aside that this way of running never captures one: it does, to
   read it here.
4. **What may leave is names, not the screen.** A run of words is offered only
   if it reads like the name of something: at most 48 characters, containing a
   letter, free of the punctuation that belongs to code and prose (`" { } ; =
| \ ` <`), not ending in a comma. At most 40 per screen, tallest type
   first. A run overlapping any text field, search field or password field
   known to accessibility is dropped outright — what a person typed is theirs.
5. **A word is a target like an element.** Its id continues past the element
   ids, so a target is one or the other and never both, and it goes stale the
   same way: a shared-screen change refuses it. Everything after that is
   unchanged — the same resolve, the same live check that what is under the
   point is still what was approved, the same floor, the same gate, the same
   phone feed.
6. **The phone says so, and the revision moves.** `AI_CONSENT_POLICY` goes to 4. The category of thing that can leave has widened, and nobody should
   arrive here under wording they agreed to for something narrower.
7. **No detector ships.** The reference converts OmniParser to CoreML for the
   controls it cannot read. That is weights in the bundle, and the download
   ceiling is 25 MiB with the DMG already at 23.0 (L-355). Text is what Vision
   gives for nothing, and text is what this loop acts on.

## Alternatives

- **Ship OmniParser as CoreML.** Better detection, particularly for icon-only
  controls with no text at all. It does not fit under the download ceiling,
  and a first run that downloads weights is a different product decision.
  Revisit if the size budget changes.
- **Read the screen on every step and fuse it with accessibility.** Names the
  icon-only buttons too, which this does not. It also pays a capture and a
  recognition on every step of every run, and it sends words from every screen
  rather than only from the screens that have no other description. Not now;
  the fallback is where the failure actually was.
- **Send everything Vision reads, as the reference does with `screenText`.**
  Strictly better decisions, and it would make the completion check in L-371
  work. It is also a different promise: the words inside a message someone is
  writing are on the screen. Refused without a separate decision.
- **Leave it as it was.** The honest version of this is "hosted Ask does not
  work on Electron apps", and it was already being said to people as "the app
  may not expose its controls".

## Consequences

- A screen that exposes nothing now has a description, so a task on one can
  start rather than ending at the first look.
- That description is weaker than an accessibility one: a word read off the
  screen has no role, no state and no guarantee of being a control at all.
  Supervised runs still hold every click for a person, and the live hit test
  names what is really under the point on the approval card.
- The fallback costs a capture and a recognition on the looks where it runs,
  and needs the Screen Recording grant. Without the grant it logs and behaves
  exactly as it did before.
- `AI_CONSENT_POLICY` 4 re-asks every paired phone once.
- The recognizer is Apple's and runs on the device. No new service, no new
  key, and nothing in the bundle.
