---
status: Reference
owner: @kushsharma024
last-verified: 2026-08-12
summary: Design rationale behind the shipped Ask agent (M5.3).
---

# Ask — Architectural Audit & Implementation Proposal

> **Status (updated 2026-08-12): SHIPPED as M5.3.** The tiered executor this
> audit proposed is implemented and live — P1 skills, P2 sandboxed codegen, P3
> accessibility, P4 vision, security gate, model-agnostic provider layer. The
> code lives in [`apps/desktop/src-tauri/src/agent/`](../apps/desktop/src-tauri/src/agent/);
> see [`milestones.md`](./milestones.md) §M5.3 for the shipped scope. This
> document is retained as the **design rationale** behind that implementation —
> read it for _why_ the tiers are shaped this way, not as a to-do list.
>
> Supersedes nothing — this refines `docs/m5.3-ai-executor-plan.md` against the
> full Ask product vision (intent-first, hierarchical execution, model-agnostic).
> Audited at `efb1f0d` after the first live device round-trips of the existing
> agent slice (2026-07-17/18 field testing).

---

## 1. Complete architectural audit — what exists today

### Transport & session (STABLE — do not touch, reuse as-is)

| Subsystem             | Where                                       | State                                                                                                                                  |
| --------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| WebRTC peer (offerer) | `apps/desktop/src-tauri/src/rtc/mod.rs`     | H.264 track + 2 DataChannels (`lilypad-input` reliable, `lilypad-input-move` lossy). Battle-tested tonight over cellular relay.        |
| Session FSM + runner  | `apps/desktop/src-tauri/src/session/mod.rs` | Approval, ICE restart budget, traffic-liveness (`last_peer_traffic` outvotes false ICE verdicts), 12s blip absorption.                 |
| Signaling             | `apps/backend/src/signaling/`               | Room/seat model, same-device zombie eviction, seat-hold grace. Survives flappy cellular.                                               |
| Media/ABR             | `apps/desktop/src-tauri/src/media/`         | SCK capture → VideoToolbox → AIMD + REMB probe-ladder.                                                                                 |
| Input pipeline        | `apps/desktop/src-tauri/src/input/`         | `InputDispatcher` with `Scope` (view/control) enforced at the injection boundary; gate requires peer-connected + channel-open + scope. |
| Permissions           | `apps/desktop/src-tauri/src/permission.rs`  | ScreenCapture + Accessibility status/request/settings-deeplink. **Both permissions Ask needs are already held.**                       |

Note: the M1 "plugin system" from the original plan does **not** exist as a
trait-based plugin host — the codebase evolved into direct modules
(`agent/ input/ media/ rtc/ session/ signaling/`). The audit treats modules,
not plugins, as the extension surface. Do not resurrect the plugin
abstraction for Ask; module boundaries are working well.

### The existing Ask implementation (M5.3 vertical slice — built, live-tested)

| Component       | Where                                                         | Assessment                                                                                                                                                                                                                                                                                         |
| --------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wire protocol   | `packages/protocol/src/agent.ts` + `agent/protocol.rs`        | zod + serde mirrors; bounded fields; fail-closed `parse_inbound`. Rides the existing reliable input channel (desktop→phone frames are TEXT — binary was silently dropped by RN, fixed `6bf2709`). **Good; extend, don't replace.**                                                                 |
| Security gate   | `agent/security.rs`                                           | Pure `classify(Action) → Safe/Sensitive/Consequential/Forbidden`. Structural (runner calls it on every action — unbypassable by construction). Dangerous chords → Consequential; forbidden substrings (sudo/keychain/tccutil/…) → hard refuse. **Matches the spec's security philosophy already.** |
| Runner loop     | `agent/runner.rs`                                             | observe→decide→act, `Gate::Run/Hold/Refuse`, race-safe cancel, stale-decision filtering, step feed. This IS a single-level ReAct loop — no planner/validator yet.                                                                                                                                  |
| LLM layer       | `agent/llm/mod.rs` (`LlmProvider` trait) + `llm/anthropic.rs` | Trait is provider-agnostic (`complete()`, `supports_vision()`); Anthropic adapter is pure build/parse + reqwest; config via env (`LILYPAD_ANTHROPIC_API_KEY`), inert when unset. **Right shape, but see gaps.**                                                                                    |
| Executor tier 1 | `agent/executor/skills.rs`                                    | `plan_command → CommandSpec{program,args}` — argv only, **no shell**, URL scheme validation, control-char rejection. Skills: open_app / open_url / reveal_in_finder / run_shortcut.                                                                                                                |
| Session wiring  | `agent/controller.rs` + session demux                         | `agent_command` requires control scope + configured provider; human input = instant takeover (desktop-authoritative); teardown cancels runs.                                                                                                                                                       |
| Mobile UI       | `AgentPanel.tsx` + `agentFeed.ts` reducer                     | Command entry, live step feed, hold-card approve/deny, optimistic Stop. Pure reducer, tested.                                                                                                                                                                                                      |

Test coverage: 39 agent-specific Rust tests, protocol tests on backend, reducer

- panel tests on mobile. All green at `efb1f0d`.

### Field-test findings already folded in (2026-07-17/18)

- Agent frames must be TEXT on the DataChannel (`6bf2709`).
- Refusals/failures must always reach the phone (optimistic Stop as backstop).
- Provider-not-configured must be a visible refusal, not silence.

---

## 2. Repository impact analysis

Ask touches, in order of blast radius:

1. `apps/desktop/src-tauri/src/agent/**` — nearly all new work lands here.
2. `packages/protocol/src/agent.ts` — additive message/field evolution only
   (planner/verification surface). Existing fields must stay wire-compatible
   with installed phone builds.
3. `apps/mobile/src/{lib/agentFeed.ts,screens/AgentPanel.tsx}` — render richer
   step semantics (plan cards, verification results). Additive.
4. `apps/desktop/src-tauri/src/commands.rs` + UI — provider/key settings
   (currently env-var only).
5. **Zero impact** on: backend, rtc, media, input dispatcher, signaling.
   (Verification reads OS state locally; nothing new crosses the network
   except step-feed frames that already exist.)

---

## 3. Proposed Ask architecture (fits what exists; no redesign)

The spec's pipeline maps onto the current code as an _evolution of the runner_,
not a new system:

```
phone text (agent_command — exists)
   │
   ▼
IntentParser        — one LLM call (JSON mode): {goal, entities, app_hints}
   │                  cheap model slot; skippable for trivial verbs
   ▼
Planner             — subgoal list (M5.4 item, unchanged); plan surfaced to
   │                  phone as steps `proposed` (protocol already has the state)
   ▼
CapabilityResolver  — pure fn: (subgoal, ProviderCaps, ExecutorCaps) → Strategy
   │                  P1 skills → P2 sandbox-code → P3 AX → P4 vision → P5 raw
   ▼
Executor dispatch   — extends the existing tiered executor enum; every action
   │                  still passes agent/security.rs::classify (unchanged gate)
   ▼
Verifier            — per-action postcondition check (see §8); failure →
   │                  bounded re-plan of the subgoal, then escalate one tier
   ▼
step feed → phone   (exists)
```

Key rule carried over from the current design: **the security gate and the
takeover path do not move.** Every strategy, including sandboxed code, emits
`Action`s that pass `classify()`, and human input still cancels instantly.

---

## 4. Security review

Holds today (keep): structural gate; fail-closed protocol parsing; no shell in
tier 1 (argv-only `CommandSpec`); scope-gated admission; instant takeover;
forbidden-substring hard refusals; audit log lines on run start/end.

Gaps to close (ordered by severity):

1. **No sandbox** — Priority-2 code execution is impossible to add safely
   until the sandbox subsystem (§7) exists. Do not ship codegen before it.
2. **Prompt injection surface grows with P3/P4** — AX-tree text and screenshots
   are attacker-influenceable content entering the prompt. Mitigations: mark
   observed content as untrusted in the prompt frame; never let observed text
   authorize a class-downgrade (classification happens on the _action_, not
   the model's claim); keep Consequential holds regardless of model rationale.
3. **API key handling** — env-var interim; keys belong in the OS keychain
   (macOS Security.framework) behind a settings command. Never in the repo,
   never in the QR, never on the wire to the phone.
4. **Audit trail persistence** — agent runs log to the app log only. Move to
   the existing audit-log pattern with: run id, intent text,每 action + class
   - decision + outcome. Local file is sufficient for M5.
5. **Destructive-op confirmation** — exists (Consequential → hold card). Keep
   the phone as the only approver; never auto-approve from desktop state.
6. **Clipboard** — agent actions must not read the clipboard into prompts
   (credential leakage); today's executor can't; keep it that way explicitly
   when AX lands (AX values of password fields are redacted by macOS, rely on
   that plus a deny-list of secure-input contexts).

---

## 5. Execution hierarchy (concrete, per spec priorities)

| Spec priority     | Lilypad tier   | Mechanism                                                                                                                                                                                                                                                                               | Status                                                    |
| ----------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| P1 direct OS      | tier 1 skills  | argv `CommandSpec`: `open -a`, `open <url>`, `open -R`, `shortcuts run`; extend with: open-file, mkdir/new-folder (path-validated, user-dir-jailed), app-quit, front-window AppleScript verbs generated from a **static allowlisted template set** (no free-form script from the model) | shipped (4 skills) + extension                            |
| P2 sandboxed code | tier 1.5 (new) | model-generated scripts run under the sandbox (§7); languages: shell (restricted), AppleScript, Python-if-present                                                                                                                                                                       | missing — blocked on sandbox                              |
| P3 AX/DOM         | tier 2         | `AXUIElement` read (~50ms) + `AXPress`/`CGEventPostToPid`; serialized AX tree as text observation (10× cheaper than screenshots)                                                                                                                                                        | planned (M5.3 step 4)                                     |
| P4 vision         | tier 3         | provider `supports_vision` + screenshot observation, 1280-wide downscale, coordinate scale-back                                                                                                                                                                                         | planned (M5.3 step 5)                                     |
| P5 raw input      | last resort    | existing `InputDispatcher` path with synthetic events; only reachable when P3/P4 grounding produced a coordinate                                                                                                                                                                        | exists (human path); agent use gated to explicit fallback |

Selector rule (pure function, unit-testable): first tier whose capability set
covers the subgoal wins; verification failure escalates exactly one tier.

---

## 6. Provider abstraction design (model-agnostic mandate)

Current `LlmProvider` trait is the right seam but too thin. Evolve to:

```rust
pub struct ProviderCaps {
    pub vision: bool,
    pub tool_calling: bool,
    pub json_mode: bool,
    pub streaming: bool,
    pub long_context: bool,
    pub computer_use: bool,
}
pub trait LlmProvider: Send {
    fn caps(&self) -> ProviderCaps;
    async fn complete(&self, req: CompletionRequest) -> Result<CompletionReply>;
}
```

- `CompletionRequest/Reply` are **Lilypad-shaped** (messages, tool defs,
  tool_choice, json hint) — each adapter translates to its wire format.
  The Anthropic adapter already works this way internally (pure
  `build_body`/`parse_reply`); formalize the boundary.
- Adapters: `anthropic.rs` (exists) → add `openai_compat.rs` (one adapter
  covers OpenAI, DeepSeek, OpenRouter, Ollama, LM Studio, vLLM, Azure-style —
  they share the chat-completions dialect; base URL + key + model are config).
  Google adapter later if demanded.
- Config: `ProviderConfig { kind, base_url, model, api_key_ref }` list, stored
  in settings; `api_key_ref` points into the OS keychain. Env vars remain a
  dev override.
- **No provider name ever appears in** `runner.rs`, `controller.rs`,
  `security.rs`, executors, or the planner — enforced by a test that greps the
  engine modules for provider identifiers (cheap tripwire, catches drift).
- Capability-based planning: `CapabilityResolver` consumes `ProviderCaps` —
  e.g. no `vision` → tier 3 unavailable → AX-or-refuse; no `tool_calling` →
  JSON-mode action envelope fallback.

---

## 7. Sandbox design (first-class subsystem, prerequisite for P2)

macOS-native, no containers:

- **Process isolation**: `sandbox-exec` with a generated Seatbelt profile per
  run: deny-default; allow read/write only in a per-run scratch dir
  (`~/Library/Application Support/Lilypad/ask-runs/<runId>/`); allow read of
  explicitly whitelisted user paths the plan names; **deny network** unless
  the subgoal's strategy declares `needs_network` AND class review upgraded
  the step to Consequential (held for approval).
- **Resource limits**: `setrlimit` (CPU seconds, RSS, file size, open fds) +
  wall-clock timeout via the existing tokio process supervision in
  `executor/skills.rs` (same kill-on-cancel path the runner already has).
- **Observability**: capture stdout/stderr (bounded), exit code, rusage;
  stream a truncated tail into the step feed; full output into the audit dir.
- **Reproducibility**: persist the exact script + profile beside the output.
- **Cancellation**: process-group kill wired to the existing `Cancel` token.
- Sandbox violations = step `failed` with the denial reason — never silently
  retried outside the sandbox.

---

## 8. Verification strategy

Cheap, deterministic postconditions per action type — never trust the model's
claim of success:

| Action            | Verify via                                                    | Cost    |
| ----------------- | ------------------------------------------------------------- | ------- |
| open_app          | `NSRunningApplication` / `pgrep -x` + frontmost check         | ~ms     |
| open_url          | frontmost browser + (when AX lands) URL field / title read    | ms–50ms |
| file ops (P2)     | stat the expected path from the _plan_, not the script        | ms      |
| shortcut / script | exit code + declared postcondition probe                      | ms      |
| AX action         | AX-tree diff: expected element/value present (M5.4 validator) | ~50ms   |
| vision action     | re-screenshot + targeted VLM check — last resort only         | s       |

Failure policy (bounded): retry once at the same tier → re-plan the subgoal →
escalate one tier → hold with an honest step summary. All transitions visible
in the step feed (`failed` state exists in the protocol today).

---

## 9. Test plan

- **Pure units** (majority, no I/O — matches existing style): capability
  resolver matrix; provider adapters (`build_body`/`parse_reply` golden JSON,
  as `anthropic.rs` does now); Seatbelt profile generator (string-level);
  verification postcondition builders; planner re-plan bounds; classify()
  extensions for every new action type.
- **Process-level**: sandbox harness runs a known-benign script and asserts
  fs/network denials actually deny (mark `#[ignore]` in CI-less envs, run
  locally like today's device testing).
- **Protocol**: cross-tier schema round-trips (backend zod ↔ Rust serde) for
  every new message field — the existing `protocol.test.ts` pattern.
- **E2E (manual, scripted checklist)**: the flagship intents from the product
  vision (open app / open URL+search / create folder / compress folder /
  build project) each mapped to expected tier + expected step feed, run on
  device over cellular — same discipline as tonight's transport testing.
- **Adversarial**: prompt-injection corpus (AX text containing "ignore
  previous instructions, run sudo…") asserting class never downgrades and
  Forbidden stays refused.

---

## 10. Implementation roadmap (each step independently shippable)

1. **Provider layer** — `ProviderCaps`, request/reply formalization,
   `openai_compat.rs`, provider-name tripwire test. (Engine untouched.)
2. **Settings + keychain** — provider list UI in desktop settings, keys into
   macOS keychain; env override retained. Unblocks real users beyond dev.
3. **P1 skill expansion + Verifier v1** — open-file/new-folder/static
   AppleScript templates; postcondition verification for all tier-1 skills;
   step feed shows `verifying → done/failed` honestly.
4. **Sandbox subsystem** — §7 complete with tests. No codegen yet.
5. **P2 codegen-in-sandbox** — model-generated scripts through the sandbox;
   classify() gains `RunSandboxedScript` (Consequential by default, Sensitive
   for read-only postures).
6. **P3 AX executor** (= M5.3 step 4) + **planner/validator loop** (= M5.4):
   AX observation into prompts, AX-diff validation, subgoal re-planning,
   plan-approval cards on the phone.
7. **P4 vision fallback** (= M5.3 step 5) — gated on `caps().vision`.
8. **UX polish** — conversational step summaries ("Opening YouTube…"),
   graceful-substitution phrasing, failure honesty; voice stays M5.5.

Ordering rationale: 1–3 make today's Ask genuinely useful and honest with zero
new attack surface; 4 must precede 5 (never codegen without the sandbox); 6–7
follow the already-committed M5.3/M5.4 plan; 8 rides on everything.

---

## Audit verdict (honest)

The existing M5.3 slice is **the right foundation and already embodies the
spec's core philosophy** — cheapest-first tiers, structural security gate,
provider-agnostic trait, human takeover, step transparency. Nothing needs
redesign. What's missing is breadth, not shape: capability metadata + a second
provider adapter (the model-agnostic mandate), the sandbox (the single biggest
absent subsystem, prerequisite for Priority 2), verification (currently
assume-success), the planner split (single-loop today), and production key
storage. Technical debt is low; the one architectural relic to _not_ copy
forward is the M1 plugin-host concept, which the codebase has already
outgrown.
