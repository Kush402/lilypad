---
status: Reference
owner: @kushsharma024
last-verified: 2026-08-12
summary: M3 production audit — protocol drift findings.
---

# Protocol drift audit — Phase 1.3

**Source:** a dedicated workflow cross-referenced every field in
`packages/protocol/src/{signaling,pairing}.ts` (the zod source of truth, imported
directly by the backend and the React Native mobile app) against its hand-mirrored
Rust serde implementation in `apps/desktop/src-tauri/src/signaling/messages.rs`
(the desktop can't consume a TS package, so it hand-maintains its own copy of the
wire format). A second pair (`packages/protocol/src/input.ts` vs
`apps/desktop/src-tauri/src/input/protocol.rs`) was audited the same way and found
**zero drift** — the input protocol's Rust mirror is fully in sync today.

Every claimed discrepancy was independently re-verified against the current source
before being counted here (one candidate was rejected as a malformed/placeholder
finding). **11 confirmed for the signaling protocol; 1 fixed in Phase 1.3, 10
deferred** (this document).

## Fixed in Phase 1.3

**`ice-sdp-mline-index-numeric-range`** (high) — `packages/protocol/src/signaling.ts`'s
`sdpMLineIndex` accepted any signed integer (`z.number().int().nullable().optional()`),
while the Rust `IceCandidatePayload.sdp_mline_index` is typed `Option<u16>`. A
zod-valid negative or >65535 value would fail Rust deserialization. Fixed by
tightening the zod schema to `z.number().int().min(0).max(65_535)...` — the real
semantic domain of an SDP m-line index (never negative, never that large in
practice), which also happens to exactly match Rust's `u16` range. This means the
_backend_ now rejects a malformed value at its own validation boundary instead of
the desktop merely failing to deserialize a relayed message downstream.

## Fixed in Phase 2 (item 15)

Findings 1-9 below are now fixed in `apps/desktop/src-tauri/src/signaling/messages.rs`:
proper `DeviceKind`/`SdpType`/`SessionScope` enums replace unconstrained `String`/
`Vec<String>` fields, and length bounds are enforced via `#[serde(deserialize_with
= ...)]` helpers matching each zod `.min()`/`.max()` exactly (`roomId` enforces only
the MAX bound — the shared `Envelope` struct covers every message type, including
`error`, whose zod schema legitimately allows an empty `roomId`, so the MIN(1) bound
can't be applied at this shared-struct level the way TS's per-type schemas do).
19 new unit tests in that file's `#[cfg(test)] mod tests` cover every bound and enum
rejection case. Finding 10 (`device-name-optionality-leniency`) is the one exception —
see its entry below for why it remains deliberately unfixed.

## Deferred: Rust-side defense-in-depth gaps (not fixed — flagged for review)

All ten of these share the same shape: the Rust desktop's hand-mirrored types
accept a wire shape the TS/zod schema would reject. **Exploitability today is low**
— the backend's `SignalingMessageSchema.safeParse` (`apps/backend/src/signaling/hub.ts`)
is the actual validation boundary for every client-originated message before it is
ever relayed to another peer, so a conforming backend never forwards an
out-of-bounds value to the desktop. The residual risk is (a) no defense-in-depth if
the backend's own validation is ever bypassed or buggy, and (b) the desktop's own
_outbound_ constructors don't reject values that violate these bounds either
(though in practice the desktop only ever constructs these values from its own
real WebRTC engine, which doesn't produce pathological values).

Deliberately **not fixed now** — introducing proper Rust enums and length
validation is real, non-trivial type-system work that belongs in a reviewed
hardening pass, not a side effect of a drift-detection pass. Each is a small,
independently-shippable fix once picked up:

1. **`sdp-type-enum-not-enforced`** (medium) — zod: `type: z.enum(['offer', 'answer'])`
   (`signaling.ts:29`). Rust: `SdpPayload.sdp_type: String`, unconstrained
   (`messages.rs:142-147`). Fix: a Rust enum with `#[serde(rename_all = ...)]` or a
   custom deserializer restricting to `"offer" | "answer"`.
2. **`requested-scopes-max-length-unenforced`** (medium) — zod: `.max(8)` on
   `requestedScopes` (`signaling.ts:63`). Rust: `Vec<String>`, no cap
   (`messages.rs:104-105`).
3. **`sdp-max-length-unenforced`** (medium) — zod: 32 KiB cap on `sdp`
   (`signaling.ts:22,30`). Rust: `String`, no cap; `offer()` constructor also
   accepts unbounded `&str` (`messages.rs:146`, `:61-67`).
4. **`ice-candidate-max-length-unenforced`** (medium) — zod: 2 KiB cap on
   `candidate` (`signaling.ts:23,34`). Rust: `String`, no cap
   (`messages.rs:150-151`, `:68-83`).
5. **`device-id-length-bounds-unenforced`** (medium) — zod: 8-128 chars
   (`signaling.ts:53`, `pairing.ts:24,45`). Rust: no length check on `register()`'s
   `device_id` param or `PairRequestPayload.device_id` (`messages.rs:40-46`,
   `:100-101`).
6. **`room-id-length-bounds-unenforced`** (medium) — zod: 1-128 chars on the shared
   envelope (`signaling.ts:41`). Rust: `Envelope.room_id: String`, no cap
   (`messages.rs:21-22`) — shared by every message type.
7. **`envelope-from-not-enum-constrained`** (medium) — zod:
   `from: DeviceKindSchema` = `z.enum(['desktop', 'mobile'])`
   (`signaling.ts:43`, `pairing.ts:11`). Rust: `Envelope.from: String`, unconstrained
   (`messages.rs:23`).
8. **`granted-scopes-not-enum-constrained`** (medium) — zod: each element of
   `grantedScopes` restricted to `'view' | 'control'` (`signaling.ts:109`,
   `pairing.ts:18`). Rust: `SessionStartPayload.granted_scopes: Vec<String>`, no
   per-element constraint (`messages.rs:136-137`).
9. **`ice-server-urls-type-looser-in-rust`** (low) — zod:
   `urls: z.union([z.string(), z.array(z.string())])` (`signaling.ts:14`). Rust:
   `IceServerJson.urls: serde_json::Value` — deserializes successfully for _any_
   JSON value and silently degrades to an empty list via `url_list()` for a shape
   zod would reject outright, rather than failing loudly (`messages.rs:109-116`).
10. **`device-name-optionality-leniency`** (low) — zod: `deviceName` key is
    _required_ (nullable, not optional) — a payload omitting the key entirely is
    invalid (`signaling.ts:62`). Rust: `Option<String>` happily deserializes a
    payload that omits the key altogether (`messages.rs:102-103`).

## Drift-prevention mechanism added in Phase 1.3

`packages/protocol/fixtures/signaling-messages.json` — one canonical example
envelope per message type (all 17), validated by:

- **TS:** `apps/backend/src/protocol.contract.test.ts` — every fixture must parse
  via `SignalingMessageSchema`.
- **Rust:** `apps/desktop/src-tauri/tests/protocol_contract.rs` — every fixture
  must deserialize as `Envelope`, and the five message types with a dedicated Rust
  payload struct (`pair-request`, `offer`, `answer`, `ice-candidate`,
  `session-start`) get field-level cross-checks against the same fixture values.

Both suites read the **same file** — not two hand-written fixture sets that could
themselves drift apart. Future drift on any field this fixture set exercises fails
CI immediately, on either side, the moment either implementation changes.
