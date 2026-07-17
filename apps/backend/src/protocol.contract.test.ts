import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { SignalingMessageSchema, type SignalingType } from '@lilypad/protocol';

/**
 * Cross-language protocol contract: `packages/protocol/fixtures/signaling-messages.json`
 * is the SAME file `apps/desktop/src-tauri/tests/protocol_contract.rs` reads —
 * one canonical example envelope per wire message type, validated here against
 * the zod schema (the source of truth) and there against the hand-mirrored
 * Rust serde types. A fixture that fails on either side is real, actionable
 * drift, not a hypothetical — see the M3 architecture audit's Finding F4 and
 * `docs/audit/m3/architecture.md` for the fuller rationale.
 *
 * This does NOT replace `protocol.test.ts`'s hand-written edge-case tests
 * (missing fields, wrong types, invalid enums) — it only proves the canonical
 * "one good example per type" fixture set round-trips through both languages
 * identically.
 */

const FIXTURES_PATH = fileURLToPath(
  new URL('../../../packages/protocol/fixtures/signaling-messages.json', import.meta.url),
);

const fixtures: Record<string, unknown> = JSON.parse(readFileSync(FIXTURES_PATH, 'utf8'));

// Every message type the discriminated union declares — kept as an explicit
// list (not derived from the fixture file's own keys) so a fixture silently
// missing an entry fails loudly here, rather than the test suite quietly
// covering fewer types than the protocol actually defines.
const ALL_MESSAGE_TYPES: SignalingType[] = [
  'register',
  'pair-request',
  'pair-approved',
  'pair-denied',
  'offer',
  'answer',
  'ice-candidate',
  'session-start',
  'session-end',
  'error',
  'ping',
  'pong',
  'heartbeat',
  'pause',
  'resume',
  'renegotiate',
  'disconnect',
  'frame-size',
  'clipboard-update',
  'set-capture-mode',
];

describe('protocol contract fixtures', () => {
  it('the fixture file has exactly one entry per declared message type', () => {
    expect(Object.keys(fixtures).sort()).toEqual([...ALL_MESSAGE_TYPES].sort());
  });

  it.each(ALL_MESSAGE_TYPES)('fixture "%s" validates against SignalingMessageSchema', (type) => {
    const fixture = fixtures[type];
    expect(fixture, `no fixture found for message type "${type}"`).toBeDefined();

    const result = SignalingMessageSchema.safeParse(fixture);
    if (!result.success) {
      throw new Error(
        `fixture "${type}" failed zod validation: ${JSON.stringify(result.error.format(), null, 2)}`,
      );
    }
    expect(result.data.type).toBe(type);
  });
});
