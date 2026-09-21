---
status: Reference
owner: @kushsharma024
last-verified: 2026-09-21
summary: OCR remains a local fallback for screens with no actionable accessibility controls, but raw recognized text never leaves the Mac. Only a complete recognized label already present in the person's command may identify a visual target, and that target is bound to the pixels that were read.
---

# ADR-0022 — Hosted OCR is local targeting, not screen disclosure

## Status

Accepted — 2026-09-21. Supersedes the outbound-data and staleness clauses of
[ADR-0021](0021-ask-reads-the-screen-when-accessibility-cannot.md). The choice
to use Apple's Vision framework locally remains unchanged.

## Context

ADR-0021 tried to distinguish a control name from somebody's work using the
length and punctuation of one OCR run. That distinction cannot be made. On the
exact screen that triggers the fallback, accessibility exposes no field
rectangles, so a private line such as `Meet Bob at eight` is short,
alphabetic, and indistinguishable from a label. It could therefore be sent to
the hosted service despite the product promising otherwise.

The same patch called an OCR target stale only when the shared display changed.
A dialog, animation, or navigation on the same display could move another
control under the recorded rectangle between the look and the approved click.

## Decision

1. OCR runs only after a successful accessibility read that found zero
   actionable controls. Accessibility failures keep their real diagnosis;
   OCR does not turn a missing permission, wrong display, or unknown app into
   a usable reading.
2. Raw recognized text stays on the Mac. An OCR run is offered to hosted Jev
   only when the complete recognized label appears as a contiguous phrase in
   the person's command. The outbound label is rebuilt from the command's
   spelling, not copied from the screen. A partial word match is omitted; it
   must not turn somebody's sentence into a visual target.
3. OCR enriches the successful accessibility reading. It preserves that
   reading's app identity, keyboard focus, and window target, including the
   guard that refuses Lilypad's own window.
4. The capture's coarse fingerprint is stored with its word rectangles. Before
   an OCR-targeted click, the Mac captures the shared display again and refuses
   if the fingerprint changed. If an accessibility element named during
   approval can no longer be identified, the click is refused too.
5. `AI_CONSENT_POLICY` stays at 4. The v4 disclosure allowed more data than
   this decision now permits; tightening that boundary does not require
   another consent prompt.

## Alternatives

- **Improve the label heuristic.** Fonts, punctuation, dictionaries, and
  length can reduce false positives but cannot prove whether `Meet Bob` is a
  button or a message. Rejected as a privacy boundary.
- **Send every OCR run and rely on the provider.** This makes the loop more
  capable but changes the product into remote screen reading. Rejected.
- **Disable the fallback.** Safest but returns hosted Ask to failing on canvas
  and inaccessible Electron surfaces. The command intersection retains the
  useful named-control case without disclosing unseen text.
- **Trust the rectangle while the display is unchanged.** A display id says
  nothing about what pixels occupy it. Rejected for clicks that may follow a
  human approval delay.

## Consequences

- A command such as `click Send` can use a locally recognized Send label. An
  unrelated `Meet Bob at eight` line does not enter the request even when the
  command also names Bob; the whole recognized label would have to appear in
  the command.
- Visual controls the person did not name are unavailable to this text-only
  model. That is a deliberate capability limit, not a probabilistic privacy
  promise.
- Dynamic screens may refuse a visual click and ask for another look. This is
  safer than acting on a target whose identity is no longer current.
