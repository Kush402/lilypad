---
status: Reference
owner: @kushsharma024
last-verified: 2026-09-19
summary: Ask offers two ways to run: the person's own AI key, unchanged and free, or Lilypad's own account on the Pro plan, where a System One model (TypeSafe's Jev) drives the whole task from the accessibility reading, with no screenshot and no key, through a metered backend route.
---

# ADR-0020 — Lilypad runs computer use on its own account, for Pro

## Status

Accepted — 2026-09-19. Extends
[ADR-0018](0018-ask-operates-the-mac-under-full-control.md) (how Ask operates
the Mac) and [ADR-0019](0019-ask-does-short-commands-instantly.md) (the instant
step), and narrows [ADR-0007](0007-cloud-is-control-plane-only.md) for one
text-only path, deliberately and in public.

## Context

Ask has always needed the person's own API key. That was honest and it kept
screen data out of Lilypad's servers, but it made the product's quality
somebody else's decision. The owner's own Mac is the example: it was
configured with `openai/gpt-4o-mini-2024-07-18` through OpenRouter, and on
2026-09-19 a v0.1.45 session went like this (`~/Library/Logs/Lilypad`):

- every turn sent 76,000–79,000 input tokens and got 14 tokens back, with the
  provider's cache answering only 2,560 of them;
- asked to play something, it clicked "Ignore Limit", "Play all", "Pause",
  "Next", "Pause", "Play" in sequence, never checking whether the task was
  done;
- instant actions were off, because that Mac has no TypeSafe key.

The owner's verdict was "very bad at performing tasks and understanding
context". The model was the cause, and no amount of prompt work in Lilypad
fixes a model chosen and paid for by the customer.

Jev is the opposite trade. It cannot see a screenshot and cannot write a
sentence, but it answers typed questions about a state in about 250 ms for a
few thousandths of a cent, and ADR-0019 already sends it the accessibility
reading for one-shot commands.

**Measured, 2026-09-19, against the real API with the owner's key**, on a
scripted Mac (`jev_agent_probe`, kept in the desktop crate as
`jev_agent_fixtures.json`):

| Command                                   | Steps | Outcome                                      |
| ----------------------------------------- | ----- | -------------------------------------------- |
| "reply to Rae saying I'll be there"       | 5     | selected the row, replied, typed, sent, done |
| "archive the email from GitHub"           | 3     | selected the row, archived, done             |
| "open the downloads folder"               | 2     | opened it, done                              |
| "what does this email say"                | 1     | refused: it cannot read a page back          |
| "search youtube … and play the first one" | 2     | typed the query, then handed back            |

The shape that made this work is the third one tried. Asking "which control
comes next" as one many-way Choice spread the probability across options that
were not really competing (0.50–0.66 on the right answer). Asking **one yes/no
question per candidate control**, in the same request, gave 0.79–0.95 on the
right control and left the wrong ones under 0.1.

## Decision

1. **Two ways to run Ask.** _Your own key_ stays exactly as it is, free, with
   every provider Lilypad already speaks. _Lilypad_ is the second: no key, our
   TypeSafe account, and it needs an active subscription (ADR-0016's tier).
2. **The Lilypad way runs the whole task on Jev**, one request per step:
   whether the command is already carried out (Noul), what kind of step comes
   next (Choice), one yes/no per candidate control, which words from the
   command to type, which shortcut, which direction, which app. Code decides
   what to do with the answers, as in ADR-0019: thresholds, offered options
   only, and every action through the same resolve, floor, autonomy gate and
   phone feed.
3. **No screenshot ever leaves the Mac in this way of running.** It is not a
   promise about intent; the tier never captures one. What leaves is the
   command, the app in front, what has keyboard focus, the role and label of
   each listed control, Lilypad's own one-line summaries of the steps so far,
   and installed app names sharing a word with the command.
4. **Typing is limited to the person's own words.** Code extracts candidate
   spans from the command (quoted text, and what follows "saying", "type",
   "search for" and their kin); Jev only chooses among them. Jev never
   composes text, because it cannot.
5. **What this way cannot do, it says.** Writing new words, reading a page
   back, answering a question, or a screen where nothing is confident enough:
   the run ends naming the limit and pointing at the other way to run. It does
   not guess, and it does not silently fall back to a model the person did not
   configure.
6. **Requests go through Lilypad's backend**, authenticated by the desktop's
   existing device token, refused without entitlement, metered per account,
   and forwarded to TypeSafe on Lilypad's key. The backend stores counters,
   never payloads. This is the narrow exception to ADR-0007: text derived from
   the screen, never pixels, and only when the person chooses this way of
   running.
7. **The same loop runs on a personal TypeSafe key**, with no backend in the
   path, for anyone who has one.
8. **The phone names it.** A third destination shape — Lilypad's own account —
   with its own consent revision, and `AI_CONSENT_POLICY` moves to 3, so
   nobody arrives here under wording they agreed to for something else.

## Alternatives

- **A hosted vision model (Claude, GPT, Gemini) on Lilypad's account.**
  Strongest agent, and the one the first draft of this decision assumed. The
  owner rejected it: it sends pixels through Lilypad, and one long task
  measured 780,000 input tokens, about $2 on a good model, against fractions
  of a cent for the whole Jev loop. Left open as a later paid option if the
  Jev loop's refusals prove too common.
- **Shipping Lilypad's key inside the app.** Anyone can read a key out of an
  app bundle and spend the account. Rejected in ADR-0019 and again here.
- **Keeping BYOK as the only way.** It is the status quo that produced the
  session above. A product whose quality depends on which model a customer
  happened to paste a key for is not a product decision at all.
- **One many-way Choice for the control.** Measured worse, and the difference
  is not stylistic: it is the difference between acting at 0.9 and handing
  back at 0.55.

## Consequences

- A Pro subscriber gets computer use with nothing to configure, at about
  1,200 tokens and 250 ms per step.
- Lilypad now has a data plane, however narrow. It is text, it is metered, it
  is disclosed on the privacy page, and it is refused without a subscription.
- Tasks needing composed text still need BYOK, and the product says so in the
  moment rather than in a footnote.
- The daily allowance (25 tasks) exists to bound abuse, not cost.
- Jev's answers are calibrated per version. The pin (`jev-1.13.0`) and the
  recapture rule from ADR-0019 cover this loop too.
