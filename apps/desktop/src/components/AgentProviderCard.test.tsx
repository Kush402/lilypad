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
    defaultModel: 'claude-opus-4-8',
  },
  {
    id: 'gemini',
    displayName: 'Google Gemini',
    dialect: 'openai_compat',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    authHint: 'A Gemini API key from Google AI Studio.',
    modelDiscovery: true,
    requiresKey: true,
    note: "Uses Google's OpenAI-compatible endpoint.",
    defaultModel: '',
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    dialect: 'openai_compat',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    authHint: 'An OpenRouter API key from openrouter.ai/keys.',
    modelDiscovery: true,
    requiresKey: true,
    note: 'Model names are prefixed by their vendor.',
    defaultModel: '',
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
    defaultModel: '',
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

/** The catalogue the customer actually saw, as the backend now returns it. */
const GEMINI_MODELS = [
  { id: 'models/gemini-2.5-flash', suitability: 'usable', reason: '' },
  {
    id: 'models/gemini-2.5-flash-native-audio-preview-12-2025',
    suitability: 'unsuitable',
    reason:
      'This is a Live model: it needs a continuous two-way audio connection, which Ask does not open. Choose a text model instead.',
  },
  {
    id: 'models/text-embedding-004',
    suitability: 'unsuitable',
    reason:
      'This model turns text into vectors for search. It does not hold a conversation, so Ask cannot use it.',
  },
];

/** Drive the card to Gemini with a listed catalogue. */
async function gemini(models: unknown = GEMINI_MODELS) {
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === 'list_provider_presets') return PRESETS;
    if (cmd === 'get_agent_config') return UNCONFIGURED;
    if (cmd === 'list_agent_models') return models;
    throw new Error(`unexpected ${cmd}`);
  });
  render(<AgentProviderCard />);
  await screen.findByLabelText('Provider');
  fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'gemini' } });
  // Choosing a provider does not advance on its own (L-279); Continue does.
  fireEvent.click(screen.getByTestId('agent-provider-continue'));
  await screen.findByLabelText('Model');
  fireEvent.click(screen.getByRole('button', { name: 'List models' }));
  await waitFor(() => expect(screen.getByTestId('agent-provider-models-filtered')).toBeTruthy());
}

describe('a model that cannot answer an Ask request (L-291)', () => {
  it('does not offer the Live Audio model the customer chose', async () => {
    await gemini();
    const offered = Array.from(document.querySelectorAll('#agent-model-options option')).map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(offered).toContain('models/gemini-2.5-flash');
    expect(offered).not.toContain('models/gemini-2.5-flash-native-audio-preview-12-2025');
    expect(offered).not.toContain('models/text-embedding-004');
    expect(screen.getByTestId('agent-provider-models-filtered').textContent).toContain('2 of 3');
  });

  it('explains and refuses it when the id is typed by hand', async () => {
    await gemini();
    fireEvent.change(screen.getByLabelText('Model'), {
      target: { value: 'models/gemini-2.5-flash-native-audio-preview-12-2025' },
    });
    expect(screen.getByTestId('agent-provider-model-unsuitable').textContent).toContain(
      'Live model',
    );
    // Nothing is sent: this is the request that failed for the customer.
    expect(screen.getByRole('button', { name: 'Save and test' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Save without testing' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('lets a suitable model through', async () => {
    await gemini();
    fireEvent.change(screen.getByLabelText('Model'), {
      target: { value: 'models/gemini-2.5-flash' },
    });
    expect(screen.queryByTestId('agent-provider-model-unsuitable')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save and test' })).toHaveProperty('disabled', false);
  });

  it('offers everything when the endpoint publishes no metadata', async () => {
    // A local server knows nothing about methods. Silence must not empty the
    // list — that would be worse than the defect.
    await gemini([
      { id: 'llama3.1:8b', suitability: 'unknown', reason: '' },
      { id: 'qwen2.5-coder', suitability: 'unsuitable', reason: 'x' },
    ]);
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'llama3.1:8b' } });
    expect(screen.queryByTestId('agent-provider-model-unsuitable')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save and test' })).toHaveProperty('disabled', false);
  });
});

describe('a provider with no default model (L-292)', () => {
  it("asks for a model instead of silently using another vendor's default", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'list_provider_presets') return PRESETS;
      if (cmd === 'get_agent_config') return UNCONFIGURED;
      throw new Error(`unexpected ${cmd}`);
    });
    render(<AgentProviderCard />);
    await screen.findByLabelText('Provider');
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'gemini' } });
    fireEvent.click(screen.getByTestId('agent-provider-continue'));
    await screen.findByLabelText('Model');

    expect(screen.getByTestId('agent-provider-model-required')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save and test' })).toHaveProperty('disabled', true);

    // Choosing one clears it.
    fireEvent.change(screen.getByLabelText('Model'), {
      target: { value: 'models/gemini-2.5-flash' },
    });
    expect(screen.queryByTestId('agent-provider-model-required')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save and test' })).toHaveProperty('disabled', false);
  });

  it('leaves a provider that has a checked default alone', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'list_provider_presets') return PRESETS;
      if (cmd === 'get_agent_config') return UNCONFIGURED;
      throw new Error(`unexpected ${cmd}`);
    });
    render(<AgentProviderCard />);
    await screen.findByLabelText('Provider');
    fireEvent.click(await screen.findByTestId('agent-provider-continue'));
    await screen.findByLabelText('Model');
    // Anthropic is the default selection and has a validated default model.
    expect(screen.queryByTestId('agent-provider-model-required')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save and test' })).toHaveProperty('disabled', false);
  });
});

/**
 * The catalogue arrives without being asked for (L-311).
 *
 * `List models` was a button a person had to know to press, and everything
 * that judges a model hangs off the list it fetches: with no listing, a typed
 * or pasted id is judged by nothing and Save is enabled. So the L-310 guard —
 * and L-291's before it — only protected somebody who had already clicked.
 *
 * The owner's v0.1.36 install had `google/gemini-3-flash-preview:batch` saved,
 * a model that cannot answer at all.
 */
describe('the model catalogue loads by itself', () => {
  const OPENROUTER_MODELS = [
    { id: 'google/gemini-3-flash-preview', suitability: 'unknown', reason: '' },
    {
      id: 'google/gemini-3-flash-preview:batch',
      suitability: 'unsuitable',
      reason:
        'This is the batch version of the model. It answers through a queue that returns results later, not the live connection Ask uses. Choose the same model without the :batch ending.',
    },
  ];

  /** Ask `openrouterWithKey` for an endpoint that cannot be listed. NOT a
   *  rejected promise: one built here would sit unhandled between this line
   *  and the moment the mock returns it, which vitest reports as an unhandled
   *  rejection and fails the run on — every test in the file having passed. */
  const CANNOT_LIST = Symbol('cannot list');

  /** Reach the model step on OpenRouter with a key typed, and nothing clicked. */
  async function openrouterWithKey(models: unknown = OPENROUTER_MODELS) {
    const calls: string[] = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      calls.push(cmd);
      if (cmd === 'list_provider_presets') return PRESETS;
      if (cmd === 'get_agent_config') return UNCONFIGURED;
      if (cmd === 'list_agent_models') {
        if (models === CANNOT_LIST) throw new Error('nope');
        return models;
      }
      throw new Error(`unexpected ${cmd}`);
    });
    render(<AgentProviderCard />);
    await screen.findByLabelText('Provider');
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'openrouter' } });
    fireEvent.click(screen.getByTestId('agent-provider-continue'));
    await screen.findByLabelText('API key');
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-or-v1-test' } });
    return calls;
  }

  it('lists without anybody pressing List models', async () => {
    const calls = await openrouterWithKey();
    await waitFor(() => expect(calls).toContain('list_agent_models'));
    await waitFor(() => expect(screen.getByTestId('agent-provider-models-filtered')).toBeTruthy());
  });

  it('refuses a pasted batch model that nobody looked up first', async () => {
    // The whole point: this person never clicked anything. Before the
    // catalogue loaded on its own, `models` was null, so nothing judged the
    // id and both buttons were live.
    await openrouterWithKey();
    await waitFor(() => expect(screen.getByTestId('agent-provider-models-filtered')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Model'), {
      target: { value: 'google/gemini-3-flash-preview:batch' },
    });
    expect(screen.getByTestId('agent-provider-model-unsuitable').textContent).toContain(':batch');
    expect(screen.getByRole('button', { name: 'Save and test' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Save without testing' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('does not retry for ever when the endpoint cannot be listed', async () => {
    // `listModels` sets the catalogue back to null on failure, so an effect
    // that only checked "is it null" would call the endpoint without end.
    const calls = await openrouterWithKey(CANNOT_LIST);
    await waitFor(() => expect(calls.filter((c) => c === 'list_agent_models').length).toBe(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.filter((c) => c === 'list_agent_models').length).toBe(1);
  });

  it('asks for nothing while there is no credential to ask with', async () => {
    // Gemini needs a key. Listing before one is entered would answer 401 and
    // put an error on screen that the person has done nothing to deserve.
    const calls: string[] = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      calls.push(cmd);
      if (cmd === 'list_provider_presets') return PRESETS;
      if (cmd === 'get_agent_config') return UNCONFIGURED;
      if (cmd === 'list_agent_models') return GEMINI_MODELS;
      throw new Error(`unexpected ${cmd}`);
    });
    render(<AgentProviderCard />);
    await screen.findByLabelText('Provider');
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'gemini' } });
    fireEvent.click(screen.getByTestId('agent-provider-continue'));
    await screen.findByLabelText('Model');
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).not.toContain('list_agent_models');
  });
});

/**
 * A pasted key must not be sent to the wrong company (L-313).
 *
 * The catalogue loads as soon as a credential exists (L-311) and the provider
 * selection starts on Anthropic, so before this an OpenRouter key pasted on a
 * fresh install went straight to `api.anthropic.com`. Recognising the shape is
 * what stops that, and it must never refuse a key it does not know.
 */
describe('a pasted key picks its own provider', () => {
  /** Render, reach the connect step on the default provider, paste `key`. */
  async function paste(key: string, recognisedAs: string | null) {
    const calls: Array<{ cmd: string; args: unknown }> = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args: unknown) => {
      calls.push({ cmd, args });
      if (cmd === 'list_provider_presets') return PRESETS;
      if (cmd === 'get_agent_config') return UNCONFIGURED;
      if (cmd === 'recognise_api_key') return recognisedAs;
      if (cmd === 'list_agent_models') return [];
      throw new Error(`unexpected ${cmd}`);
    });
    render(<AgentProviderCard />);
    await screen.findByLabelText('Provider');
    // Untouched: the selection is still the default, Anthropic.
    expect((screen.getByLabelText('Provider') as HTMLSelectElement).value).toBe('anthropic');
    fireEvent.click(screen.getByTestId('agent-provider-continue'));
    await screen.findByLabelText('API key');
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: key } });
    return calls;
  }

  /** Every destination this key was actually sent to. */
  const listedOrigins = (calls: Array<{ cmd: string; args: unknown }>) =>
    calls
      .filter((c) => c.cmd === 'list_agent_models')
      .map((c) => (c.args as { args: { baseUrl: string } }).args.baseUrl);

  it('moves the provider to the one the key belongs to, and says where it goes', async () => {
    await paste('sk-or-v1-abcdef', 'openrouter');
    await waitFor(() => expect(screen.getByTestId('agent-provider-recognised')).toBeTruthy());
    expect((screen.getByLabelText('Provider') as HTMLSelectElement).value).toBe('openrouter');
    const said = screen.getByTestId('agent-provider-recognised').textContent ?? '';
    expect(said).toContain('OpenRouter');
    expect(said).toContain('https://openrouter.ai/api/v1');
  });

  it('never carries the key to the provider that merely happened to be selected', async () => {
    // The defect in one assertion: api.anthropic.com must never see an
    // OpenRouter key.
    const calls = await paste('sk-or-v1-abcdef', 'openrouter');
    await waitFor(() => expect(listedOrigins(calls).length).toBeGreaterThan(0));
    for (const origin of listedOrigins(calls)) {
      expect(origin).toBe('https://openrouter.ai/api/v1');
    }
    expect(listedOrigins(calls)).not.toContain('https://api.anthropic.com');
  });

  it('leaves an unrecognised key exactly where the person put it', async () => {
    // A key shape nobody has listed, or one a vendor changed this morning, is
    // not refused and does not move anything.
    await paste('some-brand-new-shape-1234', null);
    await waitFor(() =>
      expect((screen.getByLabelText('Provider') as HTMLSelectElement).value === 'anthropic').toBe(
        true,
      ),
    );
    expect(screen.queryByTestId('agent-provider-recognised')).toBeNull();
    // Still usable: nothing is disabled, nothing is complained about.
    expect(screen.getByRole('button', { name: 'Save without testing' })).toHaveProperty(
      'disabled',
      false,
    );
  });
});
