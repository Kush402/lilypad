import { describe, expect, it } from 'vitest';
import { ANSWERER_PEER_REPLACEMENT_CAPABILITY, SignalingMessageSchema } from './signaling.js';

function answer(payload: Record<string, unknown>) {
  return {
    type: 'answer',
    roomId: 'room-1',
    from: 'mobile',
    ts: 1,
    payload: { type: 'answer', sdp: 'v=0', ...payload },
  };
}

describe('answer capabilities', () => {
  it('preserves the bounded answerer replacement capability', () => {
    const parsed = SignalingMessageSchema.parse(
      answer({ capabilities: [ANSWERER_PEER_REPLACEMENT_CAPABILITY] }),
    );

    expect(parsed.payload).toEqual({
      type: 'answer',
      sdp: 'v=0',
      capabilities: [ANSWERER_PEER_REPLACEMENT_CAPABILITY],
    });
  });

  it('keeps legacy answers valid and rejects invented capabilities', () => {
    expect(SignalingMessageSchema.safeParse(answer({})).success).toBe(true);
    expect(
      SignalingMessageSchema.safeParse(answer({ capabilities: ['peer-replacement-maybe'] }))
        .success,
    ).toBe(false);
  });
});
