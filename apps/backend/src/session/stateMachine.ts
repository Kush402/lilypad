/**
 * Explicit session state machine — no boolean spaghetti. Every transition is
 * declared; anything else throws. Terminal states have no exits.
 *
 *   idle → pairing → waiting_approval → connecting → negotiating → connected
 *                                                                    ⇅ paused
 *   (any non-terminal) → disconnected | failed | timeout   (terminal)
 */
export const SESSION_STATES = [
  'idle',
  'pairing',
  'waiting_approval',
  'connecting',
  'negotiating',
  'connected',
  'paused',
  'disconnected',
  'failed',
  'timeout',
] as const;

export type SessionState = (typeof SESSION_STATES)[number];

export const TERMINAL_STATES: readonly SessionState[] = ['disconnected', 'failed', 'timeout'];

/** Allowed transitions. Failure/timeout/disconnect are reachable from any live state. */
const FAULTS: readonly SessionState[] = ['disconnected', 'failed', 'timeout'];

const TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  idle: ['pairing', ...FAULTS],
  pairing: ['waiting_approval', ...FAULTS],
  waiting_approval: ['connecting', ...FAULTS],
  connecting: ['negotiating', ...FAULTS],
  negotiating: ['connected', ...FAULTS],
  connected: ['negotiating', 'paused', ...FAULTS], // renegotiate → negotiating
  paused: ['connected', ...FAULTS],
  disconnected: [],
  failed: [],
  timeout: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: SessionState,
    public readonly to: SessionState,
  ) {
    super(`invalid session transition: ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export type TransitionListener = (from: SessionState, to: SessionState) => void;

export class SessionStateMachine {
  private _state: SessionState;
  private readonly listener?: TransitionListener;

  constructor(initial: SessionState = 'idle', listener?: TransitionListener) {
    this._state = initial;
    this.listener = listener;
  }

  get state(): SessionState {
    return this._state;
  }

  isTerminal(): boolean {
    return TERMINAL_STATES.includes(this._state);
  }

  canTransition(to: SessionState): boolean {
    return TRANSITIONS[this._state].includes(to);
  }

  /** Transition or throw `InvalidTransitionError`. */
  transition(to: SessionState): SessionState {
    if (!this.canTransition(to)) {
      throw new InvalidTransitionError(this._state, to);
    }
    const from = this._state;
    this._state = to;
    this.listener?.(from, to);
    return this._state;
  }

  /** Try to transition; return false instead of throwing on an illegal move. */
  tryTransition(to: SessionState): boolean {
    if (!this.canTransition(to)) return false;
    this.transition(to);
    return true;
  }
}
