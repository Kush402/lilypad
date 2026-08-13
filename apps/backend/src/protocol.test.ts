import { describe, it, expect } from 'vitest';
import {
  SignalingMessageSchema,
  InputBatchSchema,
  QrPayloadSchema,
  decodeQrPayload,
  decodeScannedCode,
  AgentInboundSchema,
  AgentOutboundSchema,
  AgentMessageSchema,
} from '@lilypad/protocol';

describe('signaling schema', () => {
  it('accepts a well-formed offer', () => {
    const r = SignalingMessageSchema.safeParse({
      type: 'offer',
      roomId: 'room-1',
      from: 'desktop',
      ts: 1,
      payload: { type: 'offer', sdp: 'v=0' },
    });
    expect(r.success).toBe(true);
  });

  it('rejects an offer missing its sdp', () => {
    const r = SignalingMessageSchema.safeParse({
      type: 'offer',
      roomId: 'room-1',
      from: 'desktop',
      ts: 1,
      payload: { type: 'offer' },
    });
    expect(r.success).toBe(false);
  });

  it('rejects an unknown message type', () => {
    const r = SignalingMessageSchema.safeParse({
      type: 'hack',
      roomId: 'r',
      from: 'desktop',
      ts: 1,
      payload: {},
    });
    expect(r.success).toBe(false);
  });
});

describe('input protocol schema', () => {
  it('accepts a coalesced batch of events', () => {
    const r = InputBatchSchema.safeParse({
      kind: 'input_batch',
      events: [
        { kind: 'pointer_move', x: 0.5, y: 0.5, ts: 1 },
        { kind: 'click', x: 0.5, y: 0.5, ts: 2 },
        { kind: 'shortcut', action: 'paste', ts: 3 },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('rejects out-of-range normalized coordinates', () => {
    const r = InputBatchSchema.safeParse({
      kind: 'input_batch',
      events: [{ kind: 'pointer_move', x: 1.5, y: 0, ts: 1 }],
    });
    expect(r.success).toBe(false);
  });

  // Input events travel peer-to-peer over the DataChannel, never through the
  // backend — this schema is the only validation boundary an oversized or
  // hostile payload passes through. See docs/audit/m3/backend-security.md
  // Finding 9.
  it('rejects an oversized clipboard payload', () => {
    const r = InputBatchSchema.safeParse({
      kind: 'input_batch',
      events: [{ kind: 'clipboard', text: 'x'.repeat(64 * 1024 + 1), ts: 1 }],
    });
    expect(r.success).toBe(false);
  });

  it('accepts a clipboard payload at the size ceiling', () => {
    const r = InputBatchSchema.safeParse({
      kind: 'input_batch',
      events: [{ kind: 'clipboard', text: 'x'.repeat(64 * 1024), ts: 1 }],
    });
    expect(r.success).toBe(true);
  });

  it('rejects an oversized text_input payload', () => {
    const r = InputBatchSchema.safeParse({
      kind: 'input_batch',
      events: [{ kind: 'text_input', text: 'x'.repeat(8 * 1024 + 1), ts: 1 }],
    });
    expect(r.success).toBe(false);
  });
});

describe('QR payload schema', () => {
  it('round-trips a valid payload', () => {
    const payload = {
      v: 2 as const,
      token: 'abcdefabcdefabcdef',
      roomId: 'room-1',
      apiBaseUrl: 'http://localhost:8080',
      signalingUrl: 'ws://localhost:8080/ws/signal',
      deviceName: "Kush's MacBook Pro",
      platform: 'macos' as const,
    };
    expect(QrPayloadSchema.safeParse(payload).success).toBe(true);
    expect(decodeQrPayload(JSON.stringify(payload)).token).toBe(payload.token);
  });

  it('accepts a payload missing the optional identity fields', () => {
    const payload = {
      v: 2 as const,
      token: 'abcdefabcdefabcdef',
      roomId: 'room-1',
      apiBaseUrl: 'http://localhost:8080',
      signalingUrl: 'ws://localhost:8080/ws/signal',
    };
    expect(QrPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('rejects a wrong version', () => {
    expect(
      QrPayloadSchema.safeParse({
        v: 1,
        token: 'abcdefabcdefabcdef',
        roomId: 'r',
        apiBaseUrl: 'http://x',
        signalingUrl: 'ws://x',
      }).success,
    ).toBe(false);
  });
});

/**
 * One camera, two codes (P1). Pairing starts a session; linking hands a
 * computer to an account permanently. The phone shows different, differently
 * worded confirmations for each, so misclassifying one as the other is the
 * failure that matters most here.
 */
describe('scanned code classification', () => {
  const PAIR = JSON.stringify({
    v: 2,
    token: 'abcdefabcdefabcdef',
    roomId: 'room-1',
    apiBaseUrl: 'http://localhost:8080',
    signalingUrl: 'ws://localhost:8080/ws/signal',
    deviceName: 'a laptop',
    platform: 'macos',
  });
  const LINK = JSON.stringify({
    v: 1,
    kind: 'desktop-enrollment',
    code: 'c'.repeat(24),
    apiBaseUrl: 'http://localhost:8080',
    deviceName: 'a laptop',
    platform: 'macos',
  });

  it('classifies a pairing code as pair', () => {
    const scanned = decodeScannedCode(PAIR);
    expect(scanned.kind).toBe('pair');
  });

  it('classifies an enrollment code as link', () => {
    const scanned = decodeScannedCode(LINK);
    expect(scanned.kind).toBe('link');
    if (scanned.kind !== 'link') throw new Error('unreachable');
    expect(scanned.payload.code).toBe('c'.repeat(24));
  });

  // The two share `v` values that would otherwise collide: a pairing payload
  // is v2 and an enrollment payload is v1, so a version-first classifier would
  // read an enrollment code as an out-of-date pairing code.
  it('does not read an enrollment code as an outdated pairing code', () => {
    expect(() => decodeQrPayload(LINK)).toThrow();
    expect(decodeScannedCode(LINK).kind).toBe('link');
  });

  it('rejects anything that is neither', () => {
    expect(() => decodeScannedCode(JSON.stringify({ v: 1, kind: 'something-else' }))).toThrow();
    expect(() => decodeScannedCode('not json at all')).toThrow();
  });
});

// Agent messages ride the same peer-to-peer DataChannel as input, never
// through the backend — this schema is the only validation boundary a
// malformed or hostile agent payload passes. See docs/m5.3-ai-executor-plan.md.
describe('agent protocol schema', () => {
  it('accepts a well-formed command (phone → desktop)', () => {
    const r = AgentInboundSchema.safeParse({
      kind: 'agent_command',
      runId: 'run-1',
      text: 'open the newest PDF in Downloads',
      ts: 1,
    });
    expect(r.success).toBe(true);
  });

  it('accepts stop and decision inbound messages', () => {
    expect(AgentInboundSchema.safeParse({ kind: 'agent_stop', runId: 'r', ts: 1 }).success).toBe(
      true,
    );
    expect(
      AgentInboundSchema.safeParse({
        kind: 'agent_decision',
        runId: 'r',
        stepId: 's',
        approve: false,
        ts: 1,
      }).success,
    ).toBe(true);
  });

  it('rejects an empty command', () => {
    expect(
      AgentInboundSchema.safeParse({ kind: 'agent_command', runId: 'r', text: '', ts: 1 }).success,
    ).toBe(false);
  });

  it('rejects an oversized command payload', () => {
    expect(
      AgentInboundSchema.safeParse({
        kind: 'agent_command',
        runId: 'r',
        text: 'x'.repeat(4 * 1024 + 1),
        ts: 1,
      }).success,
    ).toBe(false);
  });

  it('does not accept an outbound step on the inbound schema (direction is enforced)', () => {
    const step = {
      kind: 'agent_step',
      runId: 'r',
      stepId: 's',
      step: 'action',
      summary: 'clicking Save',
      tier: 'ax',
      class: 'sensitive',
      state: 'running',
      ts: 1,
    };
    expect(AgentInboundSchema.safeParse(step).success).toBe(false);
    // …but it is a valid outbound message.
    expect(AgentOutboundSchema.safeParse(step).success).toBe(true);
  });

  it('accepts a run-end outbound message', () => {
    expect(
      AgentOutboundSchema.safeParse({
        kind: 'agent_run_end',
        runId: 'r',
        outcome: 'completed',
        ts: 1,
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown tool class', () => {
    expect(
      AgentOutboundSchema.safeParse({
        kind: 'agent_step',
        runId: 'r',
        stepId: 's',
        step: 'action',
        summary: 'x',
        class: 'nuke',
        state: 'held',
        ts: 1,
      }).success,
    ).toBe(false);
  });

  it('the combined message schema demuxes both directions', () => {
    expect(
      AgentMessageSchema.safeParse({ kind: 'agent_command', runId: 'r', text: 'hi', ts: 1 })
        .success,
    ).toBe(true);
    expect(
      AgentMessageSchema.safeParse({
        kind: 'agent_run_end',
        runId: 'r',
        outcome: 'stopped',
        ts: 1,
      }).success,
    ).toBe(true);
  });
});
