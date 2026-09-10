import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { AgentPanel, describeForScreenReader, readsLabel } from './AgentPanel';
import type { AgentFeedState, AgentStepView } from '../lib/agentFeed';

/**
 * Ask is gated on consent to send a screen to a third-party model
 * (`lib/aiConsent`, Guideline 5.1.2(i)). Every test below that is about the
 * feed, the input or the approval card assumes that decision was made long
 * ago, so the default here is "granted" and the gate has its own describe
 * block at the bottom.
 */
const consent = { granted: true };
jest.mock('../lib/aiConsent', () => ({
  hasAiConsent: jest.fn(async () => consent.granted),
  grantAiConsent: jest.fn(async () => {
    consent.granted = true;
  }),
  revokeAiConsent: jest.fn(async () => {
    consent.granted = false;
  }),
}));

beforeEach(() => {
  consent.granted = true;
});

/** The panel reads the keychain before it renders anything, so every case has
 * to wait for that first paint rather than asserting into an empty tree. */
const shown = (testID: string) => waitFor(() => screen.getByTestId(testID));

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
  // `phase` and `running` are two views of the same fact (L-233), so a fixture
  // that sets one and not the other would render a state the reducer cannot
  // produce. Default to a live run and derive `running` unless overridden.
  const phase = over.phase ?? (over.running ? 'running' : 'idle');
  return {
    runId: 'r1',
    phase,
    running: phase === 'running',
    steps: [],
    outcome: null,
    ...over,
  };
}

const noop = () => {};

/**
 * The Ask panel is the least technical person's most technical moment: they
 * typed a sentence and a machine is about to act on their laptop. Everything on
 * screen has to be in their language, and the one decision they are asked to
 * make has to read like a decision.
 */
describe('what the step feed shows a customer', () => {
  it('does not print the executor tier', async () => {
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
    await shown('agent-panel');
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

  it('says why it is asking, not just what for', async () => {
    render(<AgentPanel feed={held} onSend={noop} onStop={noop} onDecide={noop} />);
    await shown('agent-panel');
    expect(screen.getByTestId('agent-hold')).toBeTruthy();
    expect(screen.getByText(/won’t do this on its own/)).toBeTruthy();
    // Twice: the card, and the same step still sitting in the feed below it.
    expect(screen.getAllByText('Run a script').length).toBe(2);
  });

  it('carries the decision back with the step it belongs to', async () => {
    const onDecide = jest.fn();
    render(<AgentPanel feed={held} onSend={noop} onStop={noop} onDecide={onDecide} />);
    await shown('agent-panel');
    fireEvent.press(screen.getByTestId('agent-deny'));
    expect(onDecide).toHaveBeenCalledWith('s1', false);
    fireEvent.press(screen.getByTestId('agent-approve'));
    expect(onDecide).toHaveBeenLastCalledWith('s1', true);
  });
});

describe('what the card says about reading (L-247)', () => {
  const withApproval = (readablePaths: string[] | undefined) =>
    feed({
      running: true,
      steps: [
        step({
          state: 'held',
          toolClass: 'consequential',
          summary: 'Run a script',
          approval: {
            purpose: 'Run a shell script',
            script: { language: 'shell', source: 'cat notes.txt' },
            writablePaths: [],
            readablePaths,
            network: false,
          },
        }),
      ],
    });

  it('names the files a script may read, because reading is disclosure', async () => {
    // A sandboxed script's stdout is folded back into the model prompt and
    // sent to the provider, so a read grant leaves the Mac just as surely as a
    // write does. The card has to name it before the tap, not after.
    render(
      <AgentPanel
        feed={withApproval(['/Users/me/Documents/notes.txt'])}
        onSend={noop}
        onStop={noop}
        onDecide={noop}
      />,
    );
    await shown('agent-panel');
    expect(screen.getByText('/Users/me/Documents/notes.txt')).toBeTruthy();
  });

  it('distinguishes "reads nothing" from "this Mac did not say"', async () => {
    // An older desktop has no `readablePaths` field and grants broad read
    // access. Rendering absent as "none of your files" would state the exact
    // opposite of the truth, which is the defect this list exists to fix.
    expect(readsLabel([])).toBe('reads none of your files');
    expect(readsLabel(undefined)).toBe('reads not disclosed by this Mac');
    expect(readsLabel(['/Users/me/a.txt'])).toBe('can read /Users/me/a.txt');

    render(
      <AgentPanel feed={withApproval(undefined)} onSend={noop} onStop={noop} onDecide={noop} />,
    );
    await shown('agent-panel');
    expect(screen.getByText('not disclosed by this Mac')).toBeTruthy();
  });

  it('says the same thing to a screen reader as it shows on the card', () => {
    const spoken = describeForScreenReader(
      step({
        state: 'held',
        approval: {
          purpose: 'Run a shell script',
          writablePaths: [],
          readablePaths: ['/Users/me/Documents/notes.txt'],
          network: false,
        },
      }),
    );
    expect(spoken).toContain('can read /Users/me/Documents/notes.txt');
  });
});

describe('sending a task', () => {
  it('refuses to send whitespace, and clears the box on send', async () => {
    const onSend = jest.fn();
    render(<AgentPanel feed={feed()} onSend={onSend} onStop={noop} onDecide={noop} />);
    await shown('agent-panel');
    const input = screen.getByTestId('agent-command-input');

    fireEvent.changeText(input, '   ');
    fireEvent.press(screen.getByTestId('agent-send'));
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.changeText(input, '  open my email  ');
    fireEvent.press(screen.getByTestId('agent-send'));
    expect(onSend).toHaveBeenCalledWith('open my email');
    expect(input.props.value).toBe('');
  });

  it('offers Stop instead of Ask while a task is running', async () => {
    const onStop = jest.fn();
    render(
      <AgentPanel feed={feed({ running: true })} onSend={noop} onStop={onStop} onDecide={noop} />,
    );
    await shown('agent-panel');
    expect(screen.queryByTestId('agent-send')).toBeNull();
    fireEvent.press(screen.getByTestId('agent-stop'));
    expect(onStop).toHaveBeenCalled();
  });
});

/**
 * Guideline 5.1.2(i): "You must clearly disclose where personal data will be
 * shared with third parties, including with third-party AI, and obtain
 * explicit permission before doing so."
 *
 * Bringing your own API key does not exempt Lilypad from this. The screen
 * still leaves the Mac for a company the customer has not been introduced to,
 * and Lilypad is what sends it.
 */
describe('before a screen may be sent to a model', () => {
  it('asks first, and does not offer the input until it has an answer', async () => {
    consent.granted = false;
    render(<AgentPanel feed={feed()} onSend={noop} onStop={noop} onDecide={noop} />);

    await shown('agent-consent');
    // The whole point: there is no way to dispatch a task from this state.
    expect(screen.queryByTestId('agent-command-input')).toBeNull();
    expect(screen.queryByTestId('agent-send')).toBeNull();
  });

  it('names what leaves the Mac, not just that something does', async () => {
    consent.granted = false;
    render(<AgentPanel feed={feed()} onSend={noop} onStop={noop} onDecide={noop} />);
    await shown('agent-consent');

    // "We may share data with third parties" is the sentence this exists to
    // avoid. A person deciding needs the three facts: what is sent, where it
    // goes, and that nothing else in the product does it.
    expect(screen.getByText(/window titles/)).toBeTruthy();
    expect(screen.getByText(/Anthropic or OpenAI/)).toBeTruthy();
    expect(screen.getByText(/Nothing else in Lilypad does this/)).toBeTruthy();
  });

  it('opens the panel once allowed', async () => {
    consent.granted = false;
    render(<AgentPanel feed={feed()} onSend={noop} onStop={noop} onDecide={noop} />);
    await shown('agent-consent');

    fireEvent.press(screen.getByTestId('agent-consent-allow'));

    await shown('agent-panel');
    expect(screen.getByTestId('agent-command-input')).toBeTruthy();
  });

  it('can be taken back, or it was never consent', async () => {
    render(<AgentPanel feed={feed()} onSend={noop} onStop={noop} onDecide={noop} />);
    await shown('agent-panel');

    fireEvent.press(screen.getByTestId('agent-consent-withdraw'));

    await shown('agent-consent');
    expect(screen.queryByTestId('agent-command-input')).toBeNull();
  });

  it('refuses when the keychain will not answer, rather than assuming yes', async () => {
    // Failing open here would send somebody's screen to a third party because
    // their phone was locked. The safe direction is to ask again.
    const { hasAiConsent } = jest.requireMock('../lib/aiConsent') as {
      hasAiConsent: jest.Mock;
    };
    hasAiConsent.mockRejectedValueOnce(new Error('keychain unavailable'));

    render(<AgentPanel feed={feed()} onSend={noop} onStop={noop} onDecide={noop} />);
    await shown('agent-consent');
  });
});

describe('withdrawal while desktop state is uncertain', () => {
  it('keeps Stop reachable and prevents re-enabling while the old run may act', async () => {
    const stop = jest.fn();
    const props = { onSend: noop, onStop: stop, onDecide: noop };
    const view = render(<AgentPanel {...props} feed={feed({ phase: 'running' })} />);
    await shown('agent-panel');
    fireEvent.press(screen.getByTestId('agent-consent-withdraw'));
    expect(stop).toHaveBeenCalledTimes(1);
    view.rerender(<AgentPanel {...props} feed={feed({ phase: 'stop_unconfirmed' })} />);
    await shown('agent-withdrawal-pending');
    fireEvent.press(screen.getByTestId('agent-withdrawal-stop'));
    expect(stop).toHaveBeenCalledTimes(2);
    fireEvent.press(screen.getByTestId('agent-consent-allow'));
    expect(screen.queryByTestId('agent-panel')).toBeNull();
    view.rerender(<AgentPanel {...props} feed={feed({ phase: 'ended', outcome: 'stopped' })} />);
    expect(screen.queryByTestId('agent-withdrawal-pending')).toBeNull();
  });
});

it('preserves the same command through repeated failed sends', async () => {
  const send = jest.fn(() => false);
  render(<AgentPanel feed={feed()} onSend={send} onStop={noop} onDecide={noop} />);
  await shown('agent-command-input');
  fireEvent.changeText(screen.getByTestId('agent-command-input'), 'Open Safari');
  fireEvent.press(screen.getByTestId('agent-send'));
  fireEvent.press(screen.getByTestId('agent-send'));
  expect(send).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId('agent-command-input').props.value).toBe('Open Safari');
});
