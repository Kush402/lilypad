# Lilypad M5 — Universal AI Remote Controller: Competitive Analysis & Roadmap

> Status: planning. Supersedes the old milestone map. The previous
> `docs/m5-auth-design.md` (accounts/trusted devices) is **deferred to M6** —
> M5 is now the AI remote controller. This document is the competitive
> analysis, architecture verdict, ranked streaming work, AI controller
> design, and milestone plan.

Sources: hands-on read of the Contop repo (`slopedrop/contop`), streaming
state-of-the-art survey (Sunshine/Moonlight/Parsec/RustDesk/Jump/DCV/Stadia),
and AI computer-use + voice survey (Anthropic/OpenAI/Gemini computer use,
UI-TARS, Agent S2, Skyvern, macOS Accessibility, Apple SpeechAnalyzer). All
comparisons are technical, not marketing.

---

## 1. Competitive Analysis — Lilypad vs Contop

### What Contop is

An AI-powered remote-desktop system: install a desktop host, scan a QR from
an Android phone, then speak/type commands to an autonomous agent that runs
on the desktop, observes the screen, executes CLI/GUI/browser actions, and
streams progress back over WebRTC. **Tri-node**: React Native mobile ·
**Python/FastAPI server that runs on the desktop and is the thing that
actually touches the OS** · a thin Tauri Rust shell that manages the Python
server as a sidecar. Agent = Google ADK ReAct loop (`gemini-2.5-flash`
default) + LiteLLM multi-provider routing + a 9-backend vision router.

**Maturity: solo alpha, effectively dormant.** 11 stars, one contributor, all
`0.1.0-alpha` tags, no code push since 2026-04-09. It is a coherent _reference
design_, not a maintained or hardened product.

### Feature-by-feature

| Dimension                | Contop                                                                                                                                              | Lilypad (today)                                                                                                                  | Edge                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **AI controller**        | ADK ReAct loop, 30+ tools, planning-as-a-tool with phone approval, Dual-Tool Evaluator security gate                                                | **None**                                                                                                                         | **Contop**                                    |
| **Multi-provider LLM**   | Gemini/OpenAI/Anthropic/OpenRouter + subscription-mode CLI proxy (use your Claude Max plan)                                                         | —                                                                                                                                | **Contop**                                    |
| **Internet reach**       | Cloudflare Quick Tunnel (auto-download, zero-config) + Tailscale + LAN                                                                              | LAN-verified only; coturn TURN implemented but never deployed                                                                    | **Contop (today)**                            |
| **Video capture**        | `mss` full-frame poll → PIL LANCZOS downscale → software encode                                                                                     | **ScreenCaptureKit** (change-driven, dirty-rects available, native)                                                              | **Lilypad**                                   |
| **Video encode**         | aiortc **software** VP8/H264                                                                                                                        | **VideoToolbox hardware** H.264                                                                                                  | **Lilypad**                                   |
| **Adaptive bitrate**     | Start-bitrate priming + static caps (1.5→5 Mbps); no closed-loop control                                                                            | Loss-based **AIMD + REMB** closed-loop controller (1–10 Mbps) with quality floor                                                 | **Lilypad**                                   |
| **Reconnect**            | Kills execution on disconnect (can transfer to new peer); 30s keepalive                                                                             | Session FSM, ICE-restart budget, seat-holding grace, room resurrection across backend restart                                    | **Lilypad**                                   |
| **NAT traversal**        | Google STUN; **TURN not configured by default**                                                                                                     | Real coturn TURN with per-session per-role time-limited credentials                                                              | Lilypad (correctness) / Contop (convenience)  |
| **Pairing token**        | `uuid.uuid4()`, 30-day on-disk                                                                                                                      | `randomBytes(24)` base64url, single-use, 60s TTL, burned on redeem                                                               | **Lilypad**                                   |
| **Transport crypto**     | DTLS-SRTP; **cleartext `ws://` signaling on LAN/Tailscale**; QR DTLS fingerprint **parsed but never pinned** (advertised MITM defense not enforced) | DTLS-SRTP; WSS in production (boot-enforced); same-host origin guard                                                             | **Lilypad**                                   |
| **Secret handling**      | API keys **plaintext by design** in `~/.contop/settings.json`; actively migrates keyring→plaintext; keys embedded in QR + `GET /api/decrypted-keys` | TURN master secret never leaves server; no client secrets                                                                        | **Lilypad**                                   |
| **Input model**          | `pyautogui` moveRel/click + virtual joystick overlay                                                                                                | Pinch-zoom viewport, settle-window taps, double/triple-click via `clickState`, sticky modifiers, zoom lock, landscape full-bleed | **Lilypad**                                   |
| **Voice**                | STT-only, buffered (not streaming) push-to-talk; no real TTS                                                                                        | —                                                                                                                                | **Contop (has it)**                           |
| **Approval / safety UX** | Dual-Tool Evaluator (`before_tool_callback`, unbypassable by construction); destructive-command confirmation on phone; Away Mode PIN overlay        | Explicit Approve/Deny per session; scope enforced at injection boundary; panic disconnect                                        | Different scopes — both sound in their domain |
| **Known security holes** | Open PR: Docker sandbox **silently falls back to host**; path-traversal via substring matching (both unpatched on `main`)                           | None outstanding (post-audit)                                                                                                    | **Lilypad**                                   |
| **Test suite**           | Minimal                                                                                                                                             | 538 tests across 4 suites                                                                                                        | **Lilypad**                                   |
| **Platforms**            | Win/mac/Linux desktop, Android only (no iOS)                                                                                                        | macOS desktop, **iOS**                                                                                                           | Split                                         |

### Honest reading

- **Lilypad already beats Contop on everything that is _hard to get right_:**
  hardware-accelerated low-latency streaming, closed-loop bitrate adaptation,
  a real reconnect state machine, a correct security model, and a genuinely
  refined touch input system. Contop's streaming is a software `mss`-poll
  pipeline; its security story is partly aspirational (unpinned fingerprint,
  plaintext keys, unpatched sandbox escape).
- **Contop's single decisive lead is that it _has an AI controller_** — and
  that is the entire category this milestone is about. Its architecture there
  is worth studying: the ReAct loop, planning-as-a-tool with human approval,
  the structural (not prompt-level) security gate, and multi-backend vision
  routing are all good ideas.
- **Contop's zero-config internet reach (Cloudflare Quick Tunnel) is a real
  UX win** we lack today — a solo user gets remote access with no infra to
  deploy. Our TURN is more correct but requires standing up coturn.

### What to adopt, and what NOT to copy

**Adopt (idea, not code):**

- Structural security gate — every agent tool call passes through one
  mandatory classifier, impossible to bypass by construction.
- Planning-as-a-tool with phone-side plan approval before execution.
- Multi-provider routing, and the subscription-mode idea (let a user's
  existing Claude/OpenAI subscription power the agent) — a strong cost play.
- A zero-config remote option alongside proper TURN.
- Transparency events: always show which model/backend is acting.

**Do NOT copy:**

- **The "Python server runs on the desktop as the OS-touching brain"
  topology.** We already have a tight, hardware-accelerated Rust engine that
  owns the Mac. Bolting a heavy Python OS-driver alongside it would be a
  strict regression. Our agent belongs _in_ (or as a managed sidecar of) the
  Rust app.
- **Vision-first execution as the default.** Contop defaults to a VLM
  (UI-TARS) for grounding — slow (2–5s/step) and error-prone. See §4.
- Its secret handling, `uuid4` tokens, cleartext LAN signaling, and
  substring-based command classification — all things we already do better.

---

## 2. Architecture Recommendation

**Do not rewrite anything.** Lilypad's foundation is stronger than the
benchmark's on every axis except the one we haven't built yet. The M5 work is
**purely additive**: internet reach, streaming polish, and a new AI executor +
voice layer that plug into the existing transport, session FSM, and input
pipeline.

Two deliberate architectural choices:

1. **The AI agent loop runs on the desktop (Rust/Tauri app or a Rust-managed
   sidecar), calling cloud LLM APIs directly.** Screenshots and accessibility
   trees never transit the phone; the phone sends intent text and receives the
   existing media stream plus a new structured step-event feed over a
   DataChannel. This matches the converged industry pattern (Anthropic Cowork,
   UI-TARS-desktop, Fazm) and reuses our backend as-is (signaling + relay only).

2. **Execution is Accessibility-tree-first, not vision-first** — this is the
   moat (§4). We already hold the two macOS permissions an agent needs
   (Screen Recording + Accessibility) and already inject via CGEvent. We are
   better positioned to do AX-first execution than any Python-server design.

The one genuinely novel product surface we are uniquely positioned to own:
**live-watch co-drive** — the user watches the real screen over our
already-excellent stream, the agent overlays its intended action _before_
acting, and any touch is an instant takeover. No phone-remote competitor does
this well because none has streaming + input as good as ours.

---

## 3. Streaming Recommendations (ranked by ROI)

Our capture/encode side is already best-practice (the survey flagged
ScreenCaptureKit + VideoToolbox + 2-frame drop-queue + 30fps start + coturn as
"don't touch"). The latency gap vs Parsec/Moonlight-class systems is three
fixable things, not a codec change.

| #   | Improvement                                                                                                                                                          | Why                                                                                                      | Expected gain                                        | Cost                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------- |
| 1   | **Minimize receiver jitter buffer** — ~~send playout-delay RTP header ext; patch react-native-webrtc to set a low `jitterBufferTarget`~~ **WON'T-FIX (M5)**: no video jitter API in the JitsiWebRTC prebuilt framework, no playout-delay ext in `rtp-0.11.0`; see M5.2 note below | Largest hidden latency in the glass-to-glass chain; Multi.app measured ~90ms here on this exact scenario | **~50–90ms** _(blocked)_                             | ~~Low–med~~ (framework rebuild)                   |
| 2   | **Kill the 1s GOP → infinite GOP + PLI-triggered IDR**                                                                                                               | Periodic IDRs cause quality pumping and bitrate spikes that trip our own AIMD on static desktop content  | Large steady-state quality gain at same bitrate      | Low                                               |
| 3   | **Delay-based congestion control on TWCC** — enable `configure_twcc` in webrtc-rs, add a trendline estimator, use `min(delay-based, existing loss-based)`            | Loss-based-only reacts _after_ queues fill; Parsec/Stadia/GCC all act on delay gradients pre-loss        | Eliminates periodic latency spikes; smoother bitrate | Med (few hundred lines; str0m's BWE as reference) |
| 4   | **Verify VideoToolbox zero-latency flags** (`EnableLowLatencyRateControl`, `RealTime`, `AllowFrameReordering=false`, `MaxFrameDelayCount=0`)                         | Table stakes; enables per-frame rate control item 3 needs                                                | Up to a few frames if not already set                | Trivial                                           |
| 5   | **QP clamping + static-screen quality refresh** — cap max QP so text never smears; when SCK dirty-rects go quiet, drop to 1–5fps and spend bitrate on low-QP refresh | Biggest _perceived_ quality win for desktop content at 1–10 Mbps                                         | High perceived                                       | Low–med                                           |
| 6   | **HEVC end-to-end** — VideoToolbox HEVC low-latency encode + webrtc-rs H.265 packetizer (already in the rtp crate) + custom RN-webrtc decoder factory                | 35–50% bitrate savings → sharper text or 60fps headroom                                                  | High                                                 | **High** — do after 1–5                           |
| 7   | **Data-channel cursor overlay** — send cursor shape+position separately, composite client-side, capture with cursor off                                              | Pointer responds at input latency, not video latency; removes cursor-motion dirty frames                 | High perceived responsiveness                        | Med                                               |
| 8   | **60fps target** once pacing is fixed                                                                                                                                | Halves capture-to-feedback latency; smoother drag/scroll                                                 | Med                                                  | Low (only worth it after 1–3)                     |
| 9   | **Adaptive FEC** (keep NACK/RTX primary) — FlexFEC only when RTT>~50ms or sustained loss                                                                             | Fewer freeze-recover cycles on TURN-relayed cross-country paths                                          | Med on bad paths                                     | Med                                               |

**Skip AV1**: no Mac hardware AV1 encode is available to us, and decode-speed
complaints persist even where supported.

---

## 4. AI Controller Design

The design-space winner is a **tiered hybrid executor** with a
planner/actor/validator loop — not a pure screenshot-VLM agent (those take
1.4–2.7× more steps than needed, and the model call is 75–94% of per-step
wall-clock).

### Perception + action: three tiers, cheapest first

1. **Deterministic skills** — AppleScript/JXA/Shortcuts (auto-generated from
   apps' scripting dictionaries, osa-mcp style) + a sandboxed shell (allowlist
   - Seatbelt profile). One atomic call replaces five click cycles and is
     verifiable by return value. First choice whenever a skill covers the intent.
2. **Semantic UI** — read the macOS **Accessibility tree** (`AXUIElement`,
   ~50ms) and act on elements via `AXPress`/`CGEventPostToPid`. **40–100× faster
   than a screenshot→VLM round trip**, grounds far more reliably, and can act
   on background apps without stealing the visible cursor mid-co-drive. This is
   the default execution path and the moat — we already have Accessibility
   granted and CGEvent wired.
3. **Pixels** — Anthropic computer-use tool (`computer_20251124`, with the new
   `zoom` action), screenshots pre-downscaled to 1280×720 with coordinates
   scaled back linearly. Fallback only for canvas/Electron apps with poor AX.

Feed the model a compact serialized AX tree as text whenever possible;
text-tree steps cost ~10× less than screenshots and ground better.

### Loop: planner → actor → validator

- **Planner** produces a subgoal list; surface it to the phone for
  approve/reject before executing (Contop's planning-as-a-tool, done right).
- **Actor** executes one action via the cheapest capable tier.
- **Validator** does a cheap AX-tree diff after each action ("did the expected
  element/state appear?") and a subgoal-level check after each subgoal; on
  failure, **re-plan the subgoal** rather than blindly retrying (Agent S2 /
  Skyvern pattern).
- **Security gate**: every tool call passes through one mandatory classifier
  (Contop's structural approach) returning allow / sandbox / require-approval.
  Enforce in the desktop daemon, never in client UI state.

### Model strategy

Anthropic `computer_20251124` tool with medium thinking as the default (free
prompt-injection classifiers, `zoom`). Cost tiering later: cheap executor +
expensive advisor consulted at planning moments. Add the subscription-proxy
idea (route through the user's own Claude/OpenAI plan) as an option.

### Voice

**On-device Apple SpeechAnalyzer** (iOS 26), push-to-talk (hold-speak-release
fits the mobile idiom), transcript shown as an editable **intent card** before
dispatch. Zero cost, private, ~100–300ms speech-end→text. Cloud STT
(Deepgram Nova-3) only later if jargon accuracy demands it. **TTS is opt-in
eyes-free mode only** — when the user is watching the live stream, visual
step-feed + haptics beat spoken status; spend the latency budget on action
speed instead.

### Hybrid control (the differentiator)

- Any phone touch-drag or physical Mac mouse move **instantly pauses the
  agent** (Operator takeover semantics).
- Suspend screenshot capture into model context while the user types secrets.
- Per-app permission grants on first touch.
- Risky-action approval as a **typed card** on the phone (action, target,
  evidence crop, rollback note) — not a bare yes/no.
- Overlay the agent's intended click target on the live stream ~100–200ms
  before it acts.

### Latency / cost reality (set expectations)

- Voice → first visible action: ~1.5–3.5s (show "heard: …" + thinking
  indicator immediately).
- Per step: 1.5–4s for vision-tier; **sub-500ms for AX-tier**. Multi-step
  tasks take minutes — design for _supervised waiting_ (step feed + live
  stream), not instant magic.
- A 10–20-step task ≈ $0.10–0.50 on a Sonnet-class model, near-zero for steps
  resolved by skills/AX tiers. Cap step budgets; force subgoal checkpoints
  (long-horizon tasks blow up nonlinearly).

---

## 5. M5 Implementation Plan

Sequenced to ship user value early. Each sub-milestone is independently
valuable — the product is better after each one even if the next never ships.

### M5.1 — Internet reach _(unlocks the core promise; highest immediate value)_

- **Purpose**: Lilypad works from anywhere, not just the same Wi-Fi.
- **Tasks**: deploy backend + coturn to a real host (ops guide already
  written); validate the TURN-relayed path end-to-end (cellular ↔ NAT);
  add a **zero-config tunnel option** (Cloudflare-style) for solo users who
  won't run infra; verify WSS signaling + production boot guards on the
  deployed instance.
- **Dependencies**: none (reconnect FSM, TURN credentials, prod guards all
  exist).
- **Risks**: coturn misconfiguration (external-IP/relay-port range); symmetric
  NAT edge cases.
- **Success**: a phone on cellular controls a Mac behind home NAT, TURN-relayed,
  for 10+ minutes with reconnect across a network switch.
- **Complexity**: Low–Medium (mostly deployment + validation of built code).

### M5.2 — Streaming polish _(makes the remote control itself excellent — table stakes before AI)_

- **Purpose**: Parsec-class responsiveness.
- **Tasks**: streaming ROI items 2, 4, 5 (infinite GOP + PLI IDR, verify VT
  low-latency flags, QP clamp + static refresh) — **shipped**. Item 1 (jitter
  buffer) and item 3 (TWCC delay-based CC) — **won't-fix for M5** (see below).
- **Dependencies**: M5.1 (validate on real internet paths, not just LAN).
- **Success**: RTP timestamp pacing fix removed the drift-over-time lag (the
  bulk of the felt latency); no quality pumping on static screens; smooth
  under induced loss.
- **Complexity**: Medium.

> **Item 1 — receiver jitter buffer — won't-fix for M5 (verified 2026-07-17).**
> The prebuilt JitsiWebRTC `WebRTC.framework` that `react-native-webrtc@124.0.7`
> links exposes only **audio** jitter controls (`audioJitterBufferMaxPackets`,
> `audioJitterBufferFastAccelerate`); `RTCRtpReceiver` has no
> `jitterBufferMinimumDelay`/`jitterBufferTarget`, and the JS layer none either.
> The sender-side alternative (playout-delay RTP header extension) isn't in
> `rtp-0.11.0` and can't be injected through `TrackLocalStaticSample`'s internal
> packetizer without rewriting the send path to `TrackLocalStaticRTP` + hand
> H.264 packetization. Both routes are disproportionate for a payoff that only
> materializes on jittery cellular and that libwebrtc may clamp anyway. The RTP
> timestamp pacing fix (steady 30fps delivery) already shrinks libwebrtc's
> *adaptive* jitter buffer for free — the realistic win here is banked.
> Revisit only if a source-built libwebrtc becomes worthwhile for other reasons.

> **Item 3 — TWCC delay-based CC — won't-fix for M5.** webrtc-rs emits TWCC
> feedback but ships no delay-based bandwidth estimator; writing one is a
> research-grade effort needing real-network tuning. The loss-based AIMD + REMB
> path already adapts. Revisit post-M5 if cellular telemetry shows AIMD
> under-reacting to bufferbloat.

### M5.3 — AI executor foundation _(the headline capability)_

- **Purpose**: text-commanded agent that controls the Mac, watched live.
- **Tasks**: agent daemon in the Rust/Tauri app; **tier-2 AX-tree executor**
  (`AXUIElement` read + `CGEventPostToPid`/`AXPress`) and **tier-1 skill
  surface** (AppleScript/JXA/shell allowlist) first; **tier-3** Anthropic
  computer-use as fallback; the mandatory tool-classification security gate;
  a step-event DataChannel + mobile step-feed UI; instant-takeover on touch.
- **Dependencies**: existing Accessibility permission, CGEvent injection,
  DataChannel, session FSM.
- **Risks**: AX-tree coverage varies by app (Electron weak → vision fallback);
  agent reliability; sandbox correctness.
- **Success**: agent completes a multi-step real task (e.g. "open the latest
  PDF in Downloads and summarize it in a new note") AX-first, with vision only
  where needed, fully interruptible.
- **Complexity**: High.

### M5.4 — Planner/validator + approval UX _(reliability + safety)_

- **Purpose**: the agent recovers from mistakes and asks before risk.
- **Tasks**: planner→actor→validator loop with subgoal re-planning; plan
  approval on the phone; typed risky-action approval cards; per-app permission
  grants; agent-intent overlay on the live stream.
- **Dependencies**: M5.3.
- **Risks**: over-prompting (automation bias) vs under-prompting (unsafe).
- **Success**: agent asks before destructive/consequential actions; recovers
  from a failed subgoal without human intervention on a scripted failure.
- **Complexity**: Medium–High.

### M5.5 — Voice _(natural input layer on top of the executor)_

- **Purpose**: command by voice, hands-free.
- **Tasks**: on-device SpeechAnalyzer push-to-talk; editable intent card before
  dispatch; optional opt-in TTS status for eyes-free mode; barge-in/stop.
- **Dependencies**: M5.3 (dispatch target), M5.4 (approval surfaces).
- **Risks**: misrecognition on jargon (mitigated by the intent-card echo).
- **Success**: "hold, speak a task, release" runs the agent end-to-end with a
  visible transcript confirm.
- **Complexity**: Medium.

**Ordering rationale**: M5.1 delivers the "from anywhere" promise with code we
already have; M5.2 makes the manual product genuinely great (and AI needs a
good stream to be watchable); M5.3–M5.5 layer the differentiator on a proven
base. A user gets value after _every_ step.

---

## 6. Honest Assessment

- **Lilypad is already a better remote-control product than Contop** —
  stronger streaming, stronger security, stronger input, stronger reconnect,
  actually tested. If the goal were "best remote desktop," we are most of the
  way there and should just ship M5.1 + M5.2.
- **Contop is ahead on exactly one thing that matters for this vision: it has
  an AI controller.** That is not a small thing — it is the whole category.
  But its implementation is an alpha with real security debt and it is
  dormant, so we are chasing the _idea_, not a moving target.
- **The winning move is not to out-feature Contop — it is to combine two
  things nobody has combined well: a best-in-class live remote-control stream
  and an Accessibility-tree-first agent, with true live co-drive.** The AI
  research explicitly flagged this "live watch + general desktop agent + voice"
  slot as still open, with Anthropic (Cowork) and Astropad (Workbench)
  circling it — so the window is real but not indefinite.
- **Do not invent work**: skip AV1, skip a transport rewrite, skip accounts
  until M6, and skip building "Jarvis" TTS — visual feedback on a watched
  screen is better. The recommended list above is the set that materially
  improves the product; nothing more.
