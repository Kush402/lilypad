import type { AgentStep, AgentRunEnd, RunOutcome } from '@lilypad/protocol';

/**
 * The phone-side model of the AI agent's live step feed. A pure reducer over
 * the frames the desktop sends (`agent_step` / `agent_run_end`), kept separate
 * from the view so the merge logic — dedup by step id, stale-run filtering,
 * bounded history — is unit-testable without React. See
 * docs/m5.3-ai-executor-plan.md §6.
 */

/** One row in the feed. Mirrors an `agent_step`, minus the wire envelope. */
export interface AgentStepView {
  stepId: string;
  step: AgentStep['step'];
  summary: string;
  tier?: AgentStep['tier'];
  toolClass?: AgentStep['class'];
  state: AgentStep['state'];
  /** Present on a `held` step: the structured disclosure the approval card
   * renders. The summary alone cannot distinguish two scripts with different
   * grants (L-229). */
  approval?: AgentStep['approval'];
}

/**
 * What is actually known about the run, as opposed to what we hoped.
 *
 * The feed used to have one boolean, set the moment a command was handed to
 * the transport — which reported a command the Mac never received as running,
 * and a dropped stop as stopped (L-233). These states each mean something the
 * phone can actually justify:
 *
 *   `idle`      nothing dispatched
 *   `sending`   the frame left this device; the desktop has not answered yet
 *   `running`   the desktop answered — a step or a run_end for this run
 *   `stopping`  a stop left this device; waiting for the desktop to confirm
 *   `ended`     the desktop reported a terminal outcome
 *   `unsent`    the frame never left; nothing is running and the text is kept
 */
export type AgentPhase = 'idle' | 'sending' | 'running' | 'stopping' | 'ended' | 'unsent';

export interface AgentFeedState {
  /** The current (or most recent) run id; steps for other runs are ignored. */
  runId: string | null;
  /** What is known about the run's transport/lifecycle state. */
  phase: AgentPhase;
  /** True only while the desktop is known to be working on this run. Derived
   * from `phase` so there is one source of truth. */
  running: boolean;
  /** Steps in arrival order, one row per step id (latest state wins). */
  steps: AgentStepView[];
  /** Terminal outcome of the last finished run, if any. */
  outcome: RunOutcome | null;
}

export type AgentFeedAction =
  /** The command frame left this device. */
  | { type: 'command_sent'; runId: string }
  /** The command frame never left; the text is the caller's to restore. */
  | { type: 'command_unsent'; runId: string }
  /** A stop frame left this device; awaiting the desktop's terminal frame. */
  | { type: 'stop_sent' }
  /** A stop frame never left. The run may well still be going. */
  | { type: 'stop_unsent' }
  /** The desktop never acknowledged within the deadline. */
  | { type: 'ack_timeout'; runId: string }
  | { type: 'step'; step: AgentStep }
  | { type: 'run_end'; end: AgentRunEnd }
  | { type: 'clear' };

export const INITIAL_AGENT_FEED: AgentFeedState = {
  runId: null,
  phase: 'idle',
  running: false,
  steps: [],
  outcome: null,
};

/** How long the desktop has to acknowledge a dispatched command before the
 * phone stops claiming anything is happening. Generous — the desktop has to
 * reach a model provider before its first step — but finite, because "sending"
 * forever is the same lie in slower clothing. */
export const ACK_DEADLINE_MS = 20_000;

/** Cap the rendered history so a long-running agent can't grow the list
 * without bound. The tail (most recent) is what matters on a phone screen. */
const MAX_STEPS = 50;

export function agentFeedReducer(state: AgentFeedState, action: AgentFeedAction): AgentFeedState {
  switch (action.type) {
    case 'command_sent':
      // A new command starts a fresh feed. `sending`, not `running`: the bytes
      // left this device, which is not the same as the Mac having them.
      return { runId: action.runId, phase: 'sending', running: false, steps: [], outcome: null };

    case 'command_unsent':
      // Nothing was dispatched. Keep the run id so a later retry cannot reuse
      // it, but claim nothing about a run that does not exist.
      return { runId: action.runId, phase: 'unsent', running: false, steps: [], outcome: null };

    case 'stop_sent':
      // Only meaningful while something is believed to be in flight.
      if (state.phase !== 'sending' && state.phase !== 'running') return state;
      return { ...state, phase: 'stopping', running: false };

    case 'stop_unsent':
      // The stop never left, so the run is very likely still going. Saying
      // "Stopped." here is the lie L-233 is about.
      if (state.phase !== 'stopping') return state;
      return { ...state, phase: 'running', running: true };

    case 'ack_timeout':
      // Deadline only bites while still waiting for the first acknowledgment.
      if (state.runId !== action.runId || state.phase !== 'sending') return state;
      return { ...state, phase: 'unsent', running: false };

    case 'step': {
      const s = action.step;
      // Ignore steps for a run we're not tracking (a stale/late frame from a
      // superseded run).
      if (state.runId !== null && s.runId !== state.runId) return state;
      // A run that has already ended cannot go back to waiting on somebody, or
      // back to running. Late frames of that shape are state regression: they
      // would re-open a decision the person can no longer meaningfully answer,
      // on a run that is over (L-234). History still keeps every terminal
      // frame; only the reanimating ones are dropped.
      const ended = state.phase === 'ended';
      if (ended && (s.state === 'held' || s.state === 'running')) return state;
      const view: AgentStepView = {
        stepId: s.stepId,
        step: s.step,
        summary: s.summary,
        tier: s.tier,
        toolClass: s.class,
        state: s.state,
        approval: s.approval,
      };
      const idx = state.steps.findIndex((x) => x.stepId === s.stepId);
      let steps: AgentStepView[];
      if (idx >= 0) {
        // Same step advancing (held → running → done): replace in place.
        steps = state.steps.slice();
        steps[idx] = view;
      } else {
        steps = [...state.steps, view];
        if (steps.length > MAX_STEPS) steps = steps.slice(steps.length - MAX_STEPS);
      }
      // A step frame IS the desktop's acknowledgment: it has the command and
      // is working on it. A stop already in flight is not undone by it.
      const phase = state.phase === 'sending' ? 'running' : state.phase;
      return { ...state, steps, phase, running: phase === 'running' };
    }

    case 'run_end':
      if (state.runId !== null && action.end.runId !== state.runId) return state;
      // The desktop's terminal frame is the only thing that ends a run, and it
      // is also the acknowledgment a pending stop was waiting for.
      return { ...state, phase: 'ended', running: false, outcome: action.end.outcome };

    case 'clear':
      return INITIAL_AGENT_FEED;

    default:
      return state;
  }
}

/** The single step currently awaiting the user's approve/deny, if any. The
 * desktop blocks on exactly one held step at a time, so this is unambiguous.
 *
 * A finished run holds nothing. The desktop stops listening for a decision the
 * moment the run ends, so an approval card left on screen afterwards is an
 * offer nobody is waiting for — and the optimistic Stop path made that state
 * immediate (L-234). The held row stays in the feed as historical evidence
 * that it was never answered; only its controls go away. */
export function heldStep(state: AgentFeedState): AgentStepView | null {
  if (!state.running) return null;
  return state.steps.find((s) => s.state === 'held') ?? null;
}
