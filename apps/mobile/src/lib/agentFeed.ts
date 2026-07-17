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
}

export interface AgentFeedState {
  /** The current (or most recent) run id; steps for other runs are ignored. */
  runId: string | null;
  /** True between `command_sent` and the matching `run_end`. */
  running: boolean;
  /** Steps in arrival order, one row per step id (latest state wins). */
  steps: AgentStepView[];
  /** Terminal outcome of the last finished run, if any. */
  outcome: RunOutcome | null;
}

export type AgentFeedAction =
  | { type: 'command_sent'; runId: string }
  | { type: 'step'; step: AgentStep }
  | { type: 'run_end'; end: AgentRunEnd }
  | { type: 'clear' };

export const INITIAL_AGENT_FEED: AgentFeedState = {
  runId: null,
  running: false,
  steps: [],
  outcome: null,
};

/** Cap the rendered history so a long-running agent can't grow the list
 * without bound. The tail (most recent) is what matters on a phone screen. */
const MAX_STEPS = 50;

export function agentFeedReducer(state: AgentFeedState, action: AgentFeedAction): AgentFeedState {
  switch (action.type) {
    case 'command_sent':
      // A new command starts a fresh feed.
      return { runId: action.runId, running: true, steps: [], outcome: null };

    case 'step': {
      const s = action.step;
      // Ignore steps for a run we're not tracking (a stale/late frame from a
      // superseded run).
      if (state.runId !== null && s.runId !== state.runId) return state;
      const view: AgentStepView = {
        stepId: s.stepId,
        step: s.step,
        summary: s.summary,
        tier: s.tier,
        toolClass: s.class,
        state: s.state,
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
      return { ...state, steps };
    }

    case 'run_end':
      if (state.runId !== null && action.end.runId !== state.runId) return state;
      return { ...state, running: false, outcome: action.end.outcome };

    case 'clear':
      return INITIAL_AGENT_FEED;

    default:
      return state;
  }
}

/** The single step currently awaiting the user's approve/deny, if any. The
 * desktop blocks on exactly one held step at a time, so this is unambiguous. */
export function heldStep(state: AgentFeedState): AgentStepView | null {
  return state.steps.find((s) => s.state === 'held') ?? null;
}
