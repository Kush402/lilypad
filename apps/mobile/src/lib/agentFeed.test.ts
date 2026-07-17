import type { AgentStep, AgentRunEnd } from '@lilypad/protocol';
import { agentFeedReducer, heldStep, INITIAL_AGENT_FEED, type AgentFeedState } from './agentFeed';

function step(
  partial: Partial<AgentStep> & { stepId: string; state: AgentStep['state'] },
): AgentStep {
  return {
    kind: 'agent_step',
    runId: 'run-1',
    step: 'action',
    summary: 'do a thing',
    ts: 1,
    ...partial,
  } as AgentStep;
}

function runEnd(outcome: AgentRunEnd['outcome'], runId = 'run-1'): AgentRunEnd {
  return { kind: 'agent_run_end', runId, outcome, ts: 1 };
}

describe('agentFeedReducer', () => {
  it('command_sent starts a fresh running feed', () => {
    const prior: AgentFeedState = {
      runId: 'old',
      running: false,
      steps: [{ stepId: 's', step: 'action', summary: 'x', state: 'done' }],
      outcome: 'completed',
    };
    const next = agentFeedReducer(prior, { type: 'command_sent', runId: 'run-1' });
    expect(next).toEqual({ runId: 'run-1', running: true, steps: [], outcome: null });
  });

  it('appends new steps and replaces a step advancing in place', () => {
    let s = agentFeedReducer(INITIAL_AGENT_FEED, { type: 'command_sent', runId: 'run-1' });
    s = agentFeedReducer(s, { type: 'step', step: step({ stepId: 'run-1-1', state: 'held' }) });
    expect(s.steps).toHaveLength(1);
    expect(s.steps[0].state).toBe('held');
    // Same step id advancing → replaced in place, not duplicated.
    s = agentFeedReducer(s, { type: 'step', step: step({ stepId: 'run-1-1', state: 'running' }) });
    expect(s.steps).toHaveLength(1);
    expect(s.steps[0].state).toBe('running');
    // A different step appends.
    s = agentFeedReducer(s, { type: 'step', step: step({ stepId: 'run-1-2', state: 'done' }) });
    expect(s.steps.map((x) => x.stepId)).toEqual(['run-1-1', 'run-1-2']);
  });

  it('ignores steps and end from a superseded run', () => {
    let s = agentFeedReducer(INITIAL_AGENT_FEED, { type: 'command_sent', runId: 'run-2' });
    s = agentFeedReducer(s, {
      type: 'step',
      step: step({ stepId: 'x', state: 'done', runId: 'run-1' }),
    });
    expect(s.steps).toHaveLength(0);
    const after = agentFeedReducer(s, { type: 'run_end', end: runEnd('completed', 'run-1') });
    expect(after.running).toBe(true); // unchanged — wrong run
  });

  it('run_end stops the feed and records the outcome', () => {
    let s = agentFeedReducer(INITIAL_AGENT_FEED, { type: 'command_sent', runId: 'run-1' });
    s = agentFeedReducer(s, { type: 'run_end', end: runEnd('stopped') });
    expect(s.running).toBe(false);
    expect(s.outcome).toBe('stopped');
  });

  it('maps the wire `class` field to `toolClass`', () => {
    let s = agentFeedReducer(INITIAL_AGENT_FEED, { type: 'command_sent', runId: 'run-1' });
    s = agentFeedReducer(s, {
      type: 'step',
      step: step({ stepId: 'run-1-1', state: 'held', class: 'consequential', tier: 'skill' }),
    });
    expect(s.steps[0].toolClass).toBe('consequential');
    expect(s.steps[0].tier).toBe('skill');
  });

  it('heldStep surfaces the one step awaiting approval', () => {
    let s = agentFeedReducer(INITIAL_AGENT_FEED, { type: 'command_sent', runId: 'run-1' });
    expect(heldStep(s)).toBeNull();
    s = agentFeedReducer(s, { type: 'step', step: step({ stepId: 'run-1-1', state: 'held' }) });
    expect(heldStep(s)?.stepId).toBe('run-1-1');
    s = agentFeedReducer(s, { type: 'step', step: step({ stepId: 'run-1-1', state: 'running' }) });
    expect(heldStep(s)).toBeNull();
  });

  it('clear resets to the initial state', () => {
    let s = agentFeedReducer(INITIAL_AGENT_FEED, { type: 'command_sent', runId: 'run-1' });
    s = agentFeedReducer(s, { type: 'clear' });
    expect(s).toEqual(INITIAL_AGENT_FEED);
  });
});
