---
status: Reference
owner: @kushsharma024
last-verified: 2026-09-18
summary: A short command is done as one instant action chosen by a System One model (TypeSafe's Jev) on the first look, before any language model is asked; everything else, and every failure, goes to the model as before.
---

# ADR-0019 — Ask does short commands instantly

## Status

Accepted — 2026-09-18. Implemented at source, not released or device-verified.
Builds on [ADR-0018](0018-ask-operates-the-mac-under-full-control.md) and
changes nothing it decided. [ADR-0007](0007-cloud-is-control-plane-only.md)
holds: requests go from the Mac to TypeSafe, never through Lilypad's servers.

## Context

Most of what people say to Ask by voice is one action: "click compose",
"scroll down", "go back", "open Safari". With a language model each one takes
two turns, one to act and one to look and say it is done, so a few seconds
even on a fast model. That is fine for a task and slow for a command.

The owner was admitted to TypeSafe's Jev on 2026-09-18 and asked for it to be
the fast path for computer use. Jev is a System One model: it does not write
text or read images; it answers typed questions (choose one of these options,
yes or no, a score) about a state, with calibrated probabilities, in a few
hundred milliseconds. Measured from this Mac against the real API on
2026-09-18: 133–285 ms for the whole request Ask sends.

## Decision

1. **One request on the first look.** When a run starts, Ask already takes a
   look before anything else (ADR-0018). If the command is at most 12 words,
   Ask asks Jev in one request: what kind of action this is (press a
   control, open an app, open a website written in the command, scroll, a
   standard shortcut, or something else), and which control, app, direction
   or shortcut. The controls are the look's own element list; the apps are
   installed apps that share a word with the command; the shortcuts are a
   fixed list with no quitting or deleting.
2. **Code decides, not the model.** An action is taken only when the kind of
   action has probability ≥ 0.75 and its argument ≥ 0.9 (a direction ≥ 0.8),
   and only when the argument is one Ask offered. A website address is read
   from the command's words, never chosen. The thresholds come from 32 real
   answers kept as fixtures in the desktop crate: every command there that
   names a listed control, an installed app, a written address or an offered
   shortcut clears them, and no multi-step task does.
3. **Nothing changes for anything else.** "Something else", a low
   probability, a request that fails or takes longer than 2.5 s: the language
   model takes the task on the same first look, as if this step did not
   exist. An instant action that is declined, refused or fails also hands
   the task to the model, told what happened.
4. **The same gate.** An instant action is a proposal like any other:
   resolved against the live screen, refused by the floor, held under
   supervision, shown on the phone. It is never a way around ADR-0018.
5. **A second, disclosed destination.** What leaves the Mac for TypeSafe is
   the command, the name of the app in front, the role and label of each
   listed control, and matching installed app names — never a screenshot,
   field values or window titles. `agent_ready.destination.instant` names it
   with its own consent revision. A phone that showed it echoes that
   revision and gets instant actions; a phone that did not (every older
   phone) echoes the model's revision and the run goes without them. The
   phone keys the grant on both destinations, so agreeing to the model alone
   is never agreeing to TypeSafe.
6. **The person's key, on the Mac.** The TypeSafe key is added on the Mac,
   checked against TypeSafe before it is kept, and stored in the keychain
   under `typesafe@https://api.typesafe.ai`. `TYPESAFE_API_KEY` is the
   developer override, as `LILYPAD_*` is for providers.

## Alternatives

- **Lilypad's own key, through Lilypad's server.** Every customer would get
  instant actions without a TypeSafe account, but the command and control
  names would pass through the backend. That is the data plane ADR-0007
  refuses; it would need its own decision (paid, opt-in, metered, and a new
  privacy sentence), not a side effect of this one.
- **Lilypad's key inside the app.** Anyone could read it out of the binary
  and spend the account's rate limit for every customer at once. Rejected.
- **Jev as the whole agent.** It cannot see a screenshot or write text, so
  it cannot type a reply or read a page. It chooses; the model reasons.
- **Jev deciding which clicks supervision may skip.** Its own documentation
  says content written to steer it can move the answer, and a label on a web
  page is exactly that content. Supervision stays a rule, not a judgement.

## Consequences

- A short command should take the first look plus about 0.3 s instead of
  two model turns. Not yet measured on a signed build.
- Instant actions need a TypeSafe key, and TypeSafe is invite-only today; a
  customer without one gets exactly the previous behaviour.
- Jev reads English best. A command in another language usually lands on
  "something else" and goes to the model, which is the safe direction.
- When the questions or the fixtures' screens change, the fixtures are
  captured again from the real API (`capture_real_jev_answers`), never
  written by hand.
- The site's privacy page names TypeSafe as a recipient when a key is added.
