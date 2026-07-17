import { describe, it, expect } from 'vitest';
import {
  SessionStateMachine,
  InvalidTransitionError,
  TERMINAL_STATES,
  type SessionState,
} from './stateMachine.js';

describe('SessionStateMachine', () => {
  it('walks the happy path idle → … → connected', () => {
    const m = new SessionStateMachine();
    expect(m.state).toBe('idle');
    for (const s of [
      'pairing',
      'waiting_approval',
      'connecting',
      'negotiating',
      'connected',
    ] as const) {
      m.transition(s);
    }
    expect(m.state).toBe('connected');
    expect(m.isTerminal()).toBe(false);
  });

  it('supports pause/resume and renegotiate from connected', () => {
    const m = new SessionStateMachine('connected');
    expect(m.tryTransition('paused')).toBe(true);
    expect(m.tryTransition('connected')).toBe(true);
    expect(m.tryTransition('negotiating')).toBe(true); // renegotiate
    expect(m.tryTransition('connected')).toBe(true);
  });

  it('rejects illegal transitions and preserves state', () => {
    const m = new SessionStateMachine('idle');
    expect(() => m.transition('connected')).toThrow(InvalidTransitionError);
    expect(m.state).toBe('idle');
    expect(m.tryTransition('connected')).toBe(false);
  });

  it('can fault to disconnected/failed/timeout from any live state', () => {
    const live: SessionState[] = ['pairing', 'connecting', 'negotiating', 'connected', 'paused'];
    for (const s of live) {
      for (const fault of TERMINAL_STATES) {
        expect(new SessionStateMachine(s).tryTransition(fault)).toBe(true);
      }
    }
  });

  it('terminal states have no exits', () => {
    for (const t of TERMINAL_STATES) {
      const m = new SessionStateMachine(t);
      expect(m.isTerminal()).toBe(true);
      expect(m.tryTransition('connected')).toBe(false);
      expect(m.tryTransition('idle')).toBe(false);
    }
  });

  it('fires the listener with (from, to) on each transition', () => {
    const seen: string[] = [];
    const m = new SessionStateMachine('idle', (from, to) => seen.push(`${from}->${to}`));
    m.transition('pairing');
    m.transition('waiting_approval');
    expect(seen).toEqual(['idle->pairing', 'pairing->waiting_approval']);
  });
});
