import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { AgentProviderCard } from './AgentProviderCard';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const PRESETS = [
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    dialect: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    authHint: 'An Anthropic API key from console.anthropic.com.',
    modelDiscovery: true,
    requiresKey: true,
    note: '',
  },
  {
    id: 'ollama',
    displayName: 'Ollama (on this Mac)',
    dialect: 'openai_compat',
    defaultBaseUrl: 'http://localhost:11434/v1',
    authHint: 'No key needed.',
    modelDiscovery: true,
    requiresKey: false,
    note: 'Nothing you ask leaves this Mac.',
  },
];

/** A Mac with nothing set up — what a clean install shows. */
const UNCONFIGURED = {
  providerKind: null,
  profileId: null,
  model: null,
  baseUrl: null,
  origin: null,
  allowScreenshots: null,
  vision: null,
  tools: null,
  verifiedAt: null,
  hasKey: false,
  readiness: 'unconfigured',
  problem: null,
  source: 'none',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the first screen of a clean install (L-279)', () => {
  it('offers a way forward with the default provider still selected', async () => {
    // Reproduced against the previous component: the step only advanced from
    // the select's `onChange`, and the select starts on Anthropic. So a person
    // who agreed with the default saw a provider row, a hint, and nothing
    // else — no key field, no save, no way on.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'list_provider_presets') return PRESETS;
      if (cmd === 'get_agent_config') return UNCONFIGURED;
      return undefined;
    });

    render(<AgentProviderCard />);
    await screen.findByTestId('agent-provider-card');

    // Nothing was touched: the default selection is still Anthropic.
    const select = await screen.findByLabelText<HTMLSelectElement>('Provider');
    expect(select.value).toBe('anthropic');

    const forward = await screen.findByTestId('agent-provider-continue');
    fireEvent.click(forward);

    // The step that was previously unreachable.
    expect(await screen.findByLabelText('API key')).toBeTruthy();
    const endpoint = screen.getByLabelText<HTMLInputElement>('Endpoint address');
    expect(endpoint.value).toBe('https://api.anthropic.com');
  });

  it('fills the chosen preset defaults when the person picks another one', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'list_provider_presets') return PRESETS;
      if (cmd === 'get_agent_config') return UNCONFIGURED;
      return undefined;
    });
    render(<AgentProviderCard />);
    const select = await screen.findByLabelText('Provider');
    fireEvent.change(select, { target: { value: 'ollama' } });
    fireEvent.click(screen.getByTestId('agent-provider-continue'));
    const endpoint = await screen.findByLabelText<HTMLInputElement>('Endpoint address');
    expect(endpoint.value).toBe('http://localhost:11434/v1');
  });
});

describe('recovering from a failed load (L-280)', () => {
  it('clears the error when Try again succeeds', async () => {
    // Reproduced against the previous component: Try again called a loader
    // that never cleared `loadError` and never re-fetched the presets, so a
    // successful retry left the same error screen on display.
    let attempt = 0;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'list_provider_presets') return PRESETS;
      if (cmd === 'get_agent_config') {
        attempt += 1;
        if (attempt === 1) throw new Error('settings unreadable');
        return UNCONFIGURED;
      }
      return undefined;
    });

    render(<AgentProviderCard />);
    await screen.findByTestId('agent-provider-load-error');

    fireEvent.click(screen.getByText('Try again'));

    await waitFor(() => expect(screen.queryByTestId('agent-provider-load-error')).toBeNull());
    expect(await screen.findByLabelText('Provider')).toBeTruthy();
  });

  it('retries the preset read too, not only the configuration', async () => {
    let presetAttempt = 0;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'list_provider_presets') {
        presetAttempt += 1;
        if (presetAttempt === 1) throw new Error('presets unavailable');
        return PRESETS;
      }
      if (cmd === 'get_agent_config') return UNCONFIGURED;
      return undefined;
    });

    render(<AgentProviderCard />);
    await screen.findByTestId('agent-provider-load-error');
    fireEvent.click(screen.getByText('Try again'));

    await waitFor(() => expect(screen.queryByTestId('agent-provider-load-error')).toBeNull());
    // The presets actually arrived, rather than the card rendering an empty
    // provider list it could never populate.
    expect(await screen.findByText('Anthropic')).toBeTruthy();
  });

  it('keeps the error, and stays retryable, when the retry also fails', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'list_provider_presets') return PRESETS;
      if (cmd === 'get_agent_config') throw new Error('still unreadable');
      return undefined;
    });

    render(<AgentProviderCard />);
    await screen.findByTestId('agent-provider-load-error');
    fireEvent.click(screen.getByText('Try again'));
    await waitFor(() => expect(screen.getByTestId('agent-provider-load-error')).toBeTruthy());
    expect(screen.getByText('Try again')).toBeTruthy();
  });
});

describe('screenshot permission is not a probe result (L-286)', () => {
  /** A Mac where the model passed a vision probe but the person never allowed
   * screenshots. One field used to hold both answers. */
  const TESTED_BUT_NOT_ALLOWED = {
    providerKind: 'anthropic',
    profileId: 'anthropic',
    model: 'claude-sonnet-4',
    baseUrl: null,
    origin: 'https://api.anthropic.com',
    allowScreenshots: false,
    vision: true,
    tools: true,
    verifiedAt: '2026-09-10T00:00:00Z',
    hasKey: true,
    readiness: 'ready',
    problem: null,
    source: 'settings',
  };

  const load = (config: unknown) =>
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'list_provider_presets') return PRESETS;
      if (cmd === 'get_agent_config') return config;
      if (cmd === 'set_agent_config') return config;
      return undefined;
    });

  it('leaves the checkbox unticked when only the model was verified', async () => {
    load(TESTED_BUT_NOT_ALLOWED);
    render(<AgentProviderCard />);
    const box = await screen.findByRole('checkbox', { name: /take screenshots/i });
    expect((box as HTMLInputElement).checked).toBe(false);
    // …and says so, rather than reporting a capability as if it were in use.
    expect(screen.getByText(/turned off above/i)).toBeTruthy();
  });

  it('ticks the checkbox from the permission, not from the measurement', async () => {
    load({ ...TESTED_BUT_NOT_ALLOWED, allowScreenshots: true, vision: null });
    render(<AgentProviderCard />);
    const box = await screen.findByRole('checkbox', { name: /take screenshots/i });
    expect((box as HTMLInputElement).checked).toBe(true);
  });

  it('sends the permission as its own field on save', async () => {
    load({ ...TESTED_BUT_NOT_ALLOWED, allowScreenshots: false, vision: null });
    render(<AgentProviderCard />);
    const box = await screen.findByRole('checkbox', { name: /take screenshots/i });
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: /save without testing/i }));
    await waitFor(() => {
      const save = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === 'set_agent_config');
      expect(save).toBeTruthy();
      const args = (save?.[1] as { args: Record<string, unknown> }).args;
      expect(args.allowScreenshots).toBe(true);
      // The probe's field is not the checkbox's field, and the card must not
      // pretend to answer for it.
      expect(args.vision).toBeUndefined();
    });
  });
});
