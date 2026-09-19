---
status: Reference
owner: @kushsharma024
last-verified: 2026-09-18
summary: Ask clicks, types, scrolls and drags through the session's own input thread, with every provider; the person may hand it full control, and a short floor holds in every mode.
---

# ADR-0018 — Ask operates the Mac under the owner's full control

## Status

Accepted — 2026-09-18. Implemented at source, not released or device-verified.
Changes the gate for pointer and keyboard actions, and supersedes L-269's
"refuse a reply with more than one tool call" (the rule it protected is kept;
see below). It does not change ADR-0017.

## Context

The owner, 2026-09-17: make Ask a real computer-use agent, better than
Codex's, working with every provider; the owner grants full control; basic
security is enough.

Until now Ask could open apps and URLs, create folders, read the
accessibility tree, press an element and take a screenshot. It could not click
a point, type, press a key, scroll or drag, and every press and URL waited for
a tap on the phone. A task like "reply to this email" was out of reach, and
the ones in reach cost one approval per step.

Codex's computer use (studied 2026-09) is a local helper that returns a
screenshot plus the key window's accessibility tree, clicks by element index
or coordinate, sets values, scrolls, drags and types, and works only with
OpenAI models. Anthropic, OpenAI and Google each publish a trained
computer-use tool of their own; open models ground on a 0–1000 grid.

## Decision

1. **One action vocabulary, one injection path.** Every gesture — click
   (1–3), drag, press/release, scroll, type, key chords, holds — is an
   `AgentOp` run on the session's existing input thread, behind exactly the
   gates the phone's input passes (live session, `control` scope,
   Accessibility). Ask acts with the phone's authority and can never have more
   of it. Every op ends with every key and button it pressed released,
   including when it is stopped part way.
2. **Every provider gets the same toolset**, named after the vendor tools'
   members (`left_click`, `type`, `key`, `scroll`, `zoom`, …) so a model trained
   on one recognizes it, plus accessibility element ids (`element`,
   `set_value`, `element_action`). A model that cannot see gets the same tools
   by element id. Anthropic models get Anthropic's trained tool, negotiated
   newest-first and stepped down only when an endpoint rejects it; its members
   decode through the same decoder.
3. **Perception is fused.** Each look is a fitted JPEG screenshot with the
   pointer drawn in, the actionable elements with ids and positions, what is
   in front and what has focus. Models without a trained tool also get
   numbered marks on the screenshot. After an action Ask waits for the screen
   to settle instead of sleeping a fixed time.
4. **A reply may carry several actions.** They run in order, each resolved,
   gated and shown on its own; the first failure stops the rest and every
   remaining call is answered "Not executed". This replaces L-269's refusal —
   which kept the model's picture honest by refusing — with answering, which
   keeps it honest without ending the run.
5. **Autonomy is per run.** `agent_command.autonomy` is `"full"` or absent.
   Full runs everything supervision would hold. Absent (every older phone) is
   supervised, and under supervision every click, drag, value change and
   element action is held — a point carries no meaning of its own, the same
   reason every accessibility press is held (L-228).
6. **The floor holds in every mode** and is refused, never offered:
   - typing into a password field, or while macOS secure input is on;
   - operating Lilypad itself;
   - the password, Touch ID, login-window and permission prompts, Keychain
     Access and Passwords;
   - lock, log-out, sleep and restart shortcuts;
   - typing a command that touches passwords, system settings or the network
     into a terminal.
     The clipboard is never read into the prompt.
7. **The person can always take over.** A touch on the phone stops the run, as
   before. A mouse press, key press, scroll or real pointer movement at the
   Mac stops it too: Ask's events carry a tag and an activity window so a
   listener can tell them from a person's, and a pointer-drift check before
   every gesture covers a Mac where the listener cannot be created.
8. **A question pauses rather than ends.** `ask_user` ends the run
   `needs_input`; an answer sent with `continues` within 15 minutes, to the
   same destination, resumes the same conversation.

## Consequences

- The phone must opt in to full control, per Mac, after the destination
  consent — and only for a Mac whose `agent_ready` lists `full_control`. An old
  phone keeps today's behaviour; an old Mac is never offered full control.
- In full control a run can send an email or delete a file without a tap on
  the phone. That is the owner's decision, stated on the choice card; the
  floor above is what it does not extend to.
- The step budget rises to 150 steps and 45 minutes. A loop guard ends a run
  that repeats the same action six times with no visible change.
- Vendor-native tools for OpenAI's Responses API and Gemini's own computer use
  are not built. Both families already get full computer use through the
  common toolset; a native dialect needs the vendor's real response shapes to
  test against, and a fixture invented to stand in for them hides exactly the
  defects it should catch.
- Screenshots still come from `CGDisplayCreateImage`. ScreenCaptureKit
  screenshots are the upgrade when macOS stops honouring it.
