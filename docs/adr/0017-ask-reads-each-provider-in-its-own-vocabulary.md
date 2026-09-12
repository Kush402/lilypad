---
status: Implemented
owner: @kushsharma024
last-verified: 2026-09-11
summary: Ask gets easier by reading each provider's own published metadata rather than by guessing, and a credential's shape may point at a preset but may never judge one.
---

# ADR-0017 — Ask reads each provider in its own vocabulary

**Implements the provider contract** written in
[the v0.1.33 product review](../v0.1.33-product-review.md#provider-support-broad-explicit-verified)
and [the v0.1.34 customer review](../v0.1.34-customer-review.md#broad-provider-support-contract).
Neither is superseded: this records how their rules are satisfied, and what
"any key from any provider" can and cannot mean.

## The ask, and the part of it that is impossible

The owner's words: _"lilypad should be smart and self evolving such that Ask
becomes the best harness for computer use using any API key from any
provider."_

Half of that is achievable and now shipped. The other half is not achievable by
any amount of cleverness, and saying so in one place is worth more than
re-deciding it every release:

- **A key authenticates a service. It does not carry that service's
  transport.** Anthropic's Messages API and OpenAI's Chat Completions are
  different request shapes with different tool, image and streaming semantics.
  A key cannot tell Lilypad how to talk to the thing it opens, so "any
  provider" means "an adapter exists for it", which is what
  [`presets.rs`](../../apps/desktop/src-tauri/src/agent/llm/presets.rs) is a
  list of. A name in that list that does not work is worse than no name.
- **A model listed is not a model that works.** A catalogue says a name
  exists. Only a request establishes that the name answers, calls tools, or
  reads images. That is what the probe is for.

## What "smart" actually buys, and where it comes from

Every improvement below comes from something the **provider itself publishes**,
so new models and new capabilities appear without a Lilypad release. That is
the achievable reading of "self evolving": Lilypad stops carrying its own
opinion about a catalogue it does not own.

| Provider   | What it publishes            | What Ask reads it as                                                               |
| ---------- | ---------------------------- | ---------------------------------------------------------------------------------- |
| Google     | `supportedGenerationMethods` | a model without `generateContent` cannot answer (L-291), across every page (L-305) |
| OpenRouter | `supported_parameters`       | a model without `tools` cannot act (L-312)                                         |
| OpenRouter | the `:batch` routing variant | a different destination, not a different model (L-310)                             |
| any        | silence                      | nothing is known, everything is offered                                            |

The last row is the load-bearing one. **Silence is never refusal.** A provider
that publishes nothing, a metadata request that fails, a model nobody has heard
of: all stay offered, and the probe decides. A capability check that can empty
a list is worse than no check.

On OpenRouter's catalogue of 2026-09-11 this is 443 models reduced to 301 that
can actually do Ask's job, entirely from OpenRouter's own fields.

## A credential's shape may point. It may never judge.

`presets.rs` has always said a preset is _not_ a key-format check, because
"providers change prefixes, and a brittle prefix list refuses valid keys while
still accepting invalid ones". That stands, and
[`recognise`](../../apps/desktop/src-tauri/src/agent/llm/presets.rs) does not
violate it: **no branch leads to a refusal**. `None` is the ordinary answer and
means "carry on with whatever provider you chose".

Recognition exists for safety before convenience. The setup screen lists a
provider's models as soon as a credential exists, and the selection starts on
Anthropic — so pasting an OpenRouter key on a fresh install sent `sk-or-v1-…`
to `api.anthropic.com`, a party it does not belong to (L-313). Recognising the
shape is what stops a key reaching the wrong company.

Two rules follow, and both are enforced in code rather than by intention:

1. **Only unmistakable, vendor-documented shapes.** A bare `sk-` is
   deliberately absent: dozens of gateways mint keys in OpenAI's shape, and
   guessing OpenAI for those causes the exact mis-delivery this exists to
   prevent.
2. **Nothing is sent while a shape is still being read.** The destination is
   settled first, and it is named on screen before the person continues.

## Consequences

- Adding a provider means an adapter plus, where the endpoint publishes
  capability, a reader for **its** vocabulary. There is no shared schema, so
  there is no shared parser.
- A provider that publishes nothing gets a longer list and a probe, not a
  worse experience than today.
- Recognition is a table that will go stale. That is survivable precisely
  because it cannot refuse: a shape that changes stops being recognised and
  setup carries on manually.
- What is still not claimed: per-provider conformance status, enterprise and
  gateway deployments needing their own auth or headers, and the Responses-only
  OpenAI capabilities. Those need adapters, not guesses.
