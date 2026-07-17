import { describe, it, expect } from 'vitest';
import {
  SignalingMessageSchema,
  InputBatchSchema,
  QrPayloadSchema,
  decodeQrPayload,
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
