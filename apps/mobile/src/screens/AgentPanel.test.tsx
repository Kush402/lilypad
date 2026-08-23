import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { AgentPanel } from './AgentPanel';
import type { AgentFeedState, AgentStepView } from '../lib/agentFeed';

function step(over: Partial<AgentStepView> = {}): AgentStepView {
  return {
    stepId: 's1',
    step: 'action',
    summary: 'Open Safari and go to asu.edu',
    tier: 'ax',
    toolClass: 'sensitive',
    state: 'done',
    ...over,
  };
}

function feed(over: Partial<AgentFeedState> = {}): AgentFeedState {
  return { runId: 'r1', running: false, steps: [], outcome: null, ...over };
}

const noop = () => {};

/**
 * The Ask panel is the least technical person's most technical moment: they
 * typed a sentence and a machine is about to act on their laptop. Everything on
 * screen has to be in their language, and the one decision they are asked to
 * make has to read like a decision.
 */
describe('what the step feed shows a customer', () => {
  it('does not print the executor tier', () => {
    // `skill` / `sandbox` / `ax` / `vision` are the four executor tiers, an
    // internal cost/capability ladder. The feed used to append them to every
    // row as "· ax", which tells a customer nothing and reads like an error.
    render(
      <AgentPanel
        feed={feed({ steps: [step({ tier: 'ax' }), step({ stepId: 's2', tier: 'vision' })] })}
        onSend={noop}
        onStop={noop}
        onDecide={noop}
      />,
    );
    for (const tier of [' · ax', ' · vision', ' · sandbox', ' · skill']) {
      expect(screen.queryByText(tier)).toBeNull();
    }
    expect(screen.getAllByText(/Open Safari and go to asu\.edu/).length).toBe(2);
  });
});

/**
 * Only `Consequential` actions are ever held: `security.rs` lets `Safe` and
 * `Sensitive` run, hard-refuses `Forbidden` without offering it, and defaults
 * anything it cannot positively recognise to `Consequential`. So every card
 * shown here is one the Mac declined to do on its own — and the card has to say
 * so, or approving becomes a habit rather than a decision.
 */
describe('the approval card', () => {
  const held = feed({
    running: true,
    steps: [step({ state: 'held', toolClass: 'consequential', summary: 'Run a script' })],
  });

  it('says why it is asking, not just what for', () => {
    render(<AgentPanel feed={held} onSend={noop} onStop={noop} onDecide={noop} />);
    expect(screen.getByTestId('agent-hold')).toBeTruthy();
    expect(screen.getByText(/won’t do this on its own/)).toBeTruthy();
    // Twice: the card, and the same step still sitting in the feed below it.
    expect(screen.getAllByText('Run a script').length).toBe(2);
  });

  it('carries the decision back with the step it belongs to', () => {
    const onDecide = jest.fn();
    render(<AgentPanel feed={held} onSend={noop} onStop={noop} onDecide={onDecide} />);
    fireEvent.press(screen.getByTestId('agent-deny'));
    expect(onDecide).toHaveBeenCalledWith('s1', false);
    fireEvent.press(screen.getByTestId('agent-approve'));
    expect(onDecide).toHaveBeenLastCalledWith('s1', true);
  });
});

describe('sending a task', () => {
  it('refuses to send whitespace, and clears the box on send', () => {
    const onSend = jest.fn();
    render(<AgentPanel feed={feed()} onSend={onSend} onStop={noop} onDecide={noop} />);
    const input = screen.getByTestId('agent-command-input');

    fireEvent.changeText(input, '   ');
    fireEvent.press(screen.getByTestId('agent-send'));
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.changeText(input, '  open my email  ');
    fireEvent.press(screen.getByTestId('agent-send'));
    expect(onSend).toHaveBeenCalledWith('open my email');
    expect(input.props.value).toBe('');
  });

  it('offers Stop instead of Ask while a task is running', () => {
    const onStop = jest.fn();
    render(
      <AgentPanel feed={feed({ running: true })} onSend={noop} onStop={onStop} onDecide={noop} />,
    );
    expect(screen.queryByTestId('agent-send')).toBeNull();
    fireEvent.press(screen.getByTestId('agent-stop'));
    expect(onStop).toHaveBeenCalled();
  });
});
