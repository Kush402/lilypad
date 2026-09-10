import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

/** Kept in step with `commands.rs::ReadinessState`. */
type Readiness = 'unconfigured' | 'savedUnverified' | 'ready' | 'needsAttention';

interface AgentConfigDto {
  providerKind: string | null;
  profileId: string | null;
  model: string | null;
  baseUrl: string | null;
  origin: string | null;
  /** The person's answer to "may Ask take screenshots". Not a measurement. */
  allowScreenshots: boolean | null;
  /** Whether image input was **observed** to work. Three-state. */
  vision: boolean | null;
  tools: boolean | null;
  verifiedAt: string | null;
  hasKey: boolean;
  readiness: Readiness;
  problem: string | null;
  source: 'env' | 'settings' | 'none';
}

interface Preset {
  id: string;
  displayName: string;
  dialect: string;
  defaultBaseUrl: string;
  authHint: string;
  modelDiscovery: boolean;
  requiresKey: boolean;
  note: string;
}

type Capability = 'supported' | 'unsupported' | 'untested';

interface ProbeReport {
  ok: boolean;
  tools: Capability;
  vision: Capability;
  message: string | null;
  failure: string | null;
  origin: string;
  model: string;
}

/** `Choose provider → Connect → Choose model → Test`. Back and forward both
 * work, and a draft survives a failure. */
type Step = 'provider' | 'connect' | 'model' | 'test';

const READINESS_LABEL: Record<Readiness, string> = {
  unconfigured: 'Not set up',
  savedUnverified: 'Saved, not tested',
  ready: 'Ready',
  needsAttention: 'Needs attention',
};

/**
 * The Ask assistant's provider setup.
 *
 * ### What this replaced, and why
 *
 * The previous card was one form with a two-item dropdown, a free-text base
 * URL and a Save button, and it reported "Configured" whenever a key existed
 * anywhere. Four separate defects lived in that:
 *
 *   - It sent `vision: null` on every save, which the Rust side read as
 *     `false`. Editing the model silently turned screenshots off (L-263).
 *   - `configured` was `config?.source !== 'none'`, and `undefined !== 'none'`
 *     is true, so it said Configured before it had loaded anything (L-264).
 *   - Save validated nothing. A wrong key, a retired model and an endpoint
 *     that cannot call tools all looked exactly like success (L-264).
 *   - There was no way to remove a key at all; blank meant keep (L-274).
 *
 * So the flow is now stepped, every state has a name, and "Ready" is something
 * a round trip established rather than something a stored string implied.
 */
export function AgentProviderCard() {
  const [config, setConfig] = useState<AgentConfigDto | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState<Step>('provider');

  // Draft. Kept across a failed save or test — retyping a key because the
  // network blipped is its own small insult.
  const [profileId, setProfileId] = useState('anthropic');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [wantVision, setWantVision] = useState(false);

  const [models, setModels] = useState<string[] | null>(null);
  const [modelsError, setModelsError] = useState('');
  const [busy, setBusy] = useState<'' | 'saving' | 'testing' | 'listing' | 'removing'>('');
  const [error, setError] = useState('');
  const [report, setReport] = useState<ProbeReport | null>(null);

  const preset = presets.find((p) => p.id === profileId);
  const dialect = preset?.dialect ?? 'anthropic';

  /**
   * The one way this card loads, used for the first render and for Try again
   * (L-280).
   *
   * The previous Try again called a function that read the configuration and
   * never touched `loadError`, so a retry that *succeeded* left the error
   * screen on display — and it never re-fetched the presets, so a failure in
   * that half could not be recovered from at all. Reproduced in a browser
   * fixture: first read rejects, second resolves, error still there.
   *
   * So: clear, load both, and let a failure set the error again.
   */
  const load = useCallback(async () => {
    setLoadError('');
    setLoading(true);
    try {
      // Defensive about the shape, not only about the throw: this card lives
      // inside the Setup window, and a command that answered with something
      // unexpected used to take the whole window down with it.
      const list = await invoke<Preset[]>('list_provider_presets');
      const presetList = Array.isArray(list) ? list : [];
      const c = await invoke<AgentConfigDto>('get_agent_config');
      if (!c || typeof c !== 'object') throw new Error('the AI settings could not be read');
      setPresets(presetList);
      setConfig(c);
      if (c.profileId) setProfileId(c.profileId);
      setModel(c.model ?? '');
      setBaseUrl(c.baseUrl ?? '');
      // The checkbox shows the permission, never the probe result. They were
      // one field, so a model that happened to pass a vision probe used to
      // tick a box the person had never ticked (L-286).
      setWantVision(c.allowScreenshots === true);
      // A configured Mac opens on the last step; an unconfigured one starts at
      // the beginning, with the default preset already usable (L-279).
      setStep(c.readiness === 'unconfigured' ? 'provider' : 'test');
    } catch (err) {
      setLoadError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Changing provider clears what belonged to the old one. A base URL or
   * model from another origin is not a default for this one. */
  const chooseProvider = (id: string) => {
    const next = presets.find((p) => p.id === id);
    setProfileId(id);
    setBaseUrl(next?.defaultBaseUrl ?? '');
    setModel('');
    setApiKey('');
    setModels(null);
    setReport(null);
    setError('');
  };

  /**
   * Move on with whatever provider is selected (L-279).
   *
   * The first version advanced only from the `onChange` of the select, and the
   * select starts on Anthropic. A clean install therefore showed the provider
   * row and nothing else — no key field, no save, no way forward — unless the
   * person happened to pick a different provider and change back. Reproduced in
   * a browser fixture against the unchanged component.
   */
  const continueFromProvider = () => {
    const chosen = presets.find((p) => p.id === profileId);
    // Fill the preset's defaults on the way through, so this is the same state
    // choosing it from the list would have produced.
    if (chosen && !baseUrl) setBaseUrl(chosen.defaultBaseUrl);
    setError('');
    setStep('connect');
  };

  const save = async (): Promise<AgentConfigDto | null> => {
    setBusy('saving');
    setError('');
    try {
      const next = await invoke<AgentConfigDto>('set_agent_config', {
        args: {
          providerKind: dialect,
          profileId,
          model: model.trim() || null,
          baseUrl: baseUrl.trim() || null,
          // Only ever sent as a real answer. Omitting it preserves whatever
          // is stored, which is what the old `null` should always have meant.
          allowScreenshots: wantVision,
          apiKey: apiKey.trim() || null,
        },
      });
      setConfig(next);
      setApiKey(''); // never keep the secret in component state post-save
      return next;
    } catch (err) {
      setError(String(err));
      return null;
    } finally {
      setBusy('');
    }
  };

  const listModels = async () => {
    setBusy('listing');
    setModelsError('');
    try {
      const ids = await invoke<string[]>('list_agent_models', {
        args: {
          providerKind: dialect,
          baseUrl: baseUrl.trim() || null,
          apiKey: apiKey.trim() || null,
        },
      });
      setModels(ids);
      if (ids.length === 0) setModelsError('This endpoint listed no models. Type the id instead.');
    } catch (err) {
      setModels(null);
      setModelsError(`${String(err)}. You can still type the model id.`);
    } finally {
      setBusy('');
    }
  };

  const test = async () => {
    setBusy('testing');
    setError('');
    setReport(null);
    try {
      const r = await invoke<ProbeReport>('test_agent_connection', {
        args: {
          providerKind: dialect,
          model: model.trim() || null,
          baseUrl: baseUrl.trim() || null,
          vision: wantVision,
          apiKey: apiKey.trim() || null,
        },
      });
      setReport(r);
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy('');
    }
  };

  const disconnect = async () => {
    setBusy('removing');
    setError('');
    try {
      const next = await invoke<AgentConfigDto>('disconnect_agent_provider');
      setConfig(next);
      setReport(null);
      setModels(null);
      setApiKey('');
      setStep('provider');
    } catch (err) {
      // A removal that failed says so. Reporting success while the key is
      // still in the keychain would be the worst possible outcome here.
      setError(`The key could not be removed: ${String(err)}`);
    } finally {
      setBusy('');
    }
  };

  if (loadError) {
    return (
      <section className="control__approve" data-testid="agent-provider-card">
        <p className="control__approve-title">
          <strong>AI Assistant (Ask)</strong>
        </p>
        <p className="error" data-testid="agent-provider-load-error">
          Lilypad could not read its AI settings: {loadError}
        </p>
        <button className="btn" disabled={loading} onClick={() => void load()}>
          {loading ? 'Trying…' : 'Try again'}
        </button>
      </section>
    );
  }

  if (loading || !config) {
    return (
      <section className="control__approve" data-testid="agent-provider-card">
        <p className="control__approve-title">
          <strong>AI Assistant (Ask)</strong>
          <span className="chip" data-testid="agent-provider-readiness">
            Checking…
          </span>
        </p>
      </section>
    );
  }

  return (
    <section className="control__approve" data-testid="agent-provider-card">
      <p className="control__approve-title">
        <strong>AI Assistant (Ask)</strong>
        <span className="chip" data-testid="agent-provider-readiness">
          {READINESS_LABEL[config.readiness]}
        </span>
      </p>

      {/* Where the SCREEN goes, not only where the key is kept. The phone asks
          for consent separately (`lib/aiConsent`, Guideline 5.1.2(i)); this is
          the other half, on the screen where the choice is actually made. */}
      <p className="muted">
        When someone uses Ask, what is on this Mac&apos;s screen (window titles and visible text) is
        sent to the provider below to work out what to do. An ordinary session sends nothing
        anywhere: it streams only between this Mac and your phone.
      </p>
      <p className="muted">Your API key is stored in the macOS keychain, never in a file.</p>

      {config.origin ? (
        <p className="muted" data-testid="agent-provider-origin">
          Requests go to <code>{config.origin}</code>
          {config.model ? ` using ${config.model}` : ''}.
        </p>
      ) : null}

      {config.source === 'env' ? (
        <p className="muted" data-testid="agent-provider-env">
          <em>
            A developer environment override is active. It decides which provider Ask actually uses;
            saving below changes the stored settings but not the running configuration.
          </em>
        </p>
      ) : null}

      {config.problem ? (
        <p className="error" data-testid="agent-provider-problem">
          {config.problem}
        </p>
      ) : null}

      {/* ── step 1: provider ───────────────────────────────────────────── */}
      <div className="row">
        <label className="muted" htmlFor="agent-preset">
          Provider
        </label>
        <select
          id="agent-preset"
          value={profileId}
          onChange={(e) => chooseProvider(e.target.value)}
        >
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
            </option>
          ))}
        </select>
      </div>

      {preset ? <p className="muted">{preset.authHint}</p> : null}
      {preset?.note ? <p className="muted">{preset.note}</p> : null}

      {step === 'provider' ? (
        <div className="row">
          <button
            className="btn btn--primary"
            data-testid="agent-provider-continue"
            onClick={continueFromProvider}
          >
            Continue
          </button>
        </div>
      ) : null}

      {/* ── step 2: connect ────────────────────────────────────────────── */}
      {step !== 'provider' ? (
        <>
          <div className="row">
            <input
              aria-label="Endpoint address"
              placeholder="Endpoint address"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>
          <div className="row">
            <input
              type="password"
              aria-label="API key"
              placeholder={
                config.hasKey
                  ? 'A key is saved for this endpoint. Enter a new one to replace it'
                  : preset?.requiresKey
                    ? 'API key'
                    : 'API key (not needed for a local model)'
              }
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
            />
          </div>

          {/* ── step 3: model ────────────────────────────────────────────── */}
          <div className="row">
            <input
              aria-label="Model"
              placeholder="Model (blank = provider default)"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              list="agent-model-options"
            />
            {preset?.modelDiscovery ? (
              <button className="btn" disabled={busy !== ''} onClick={() => void listModels()}>
                {busy === 'listing' ? 'Listing…' : 'List models'}
              </button>
            ) : null}
          </div>
          {models ? (
            <datalist id="agent-model-options">
              {models.map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
          ) : null}
          {modelsError ? (
            <p className="muted" data-testid="agent-provider-models-error">
              {modelsError}
            </p>
          ) : null}

          <div className="row">
            <label className="muted">
              <input
                type="checkbox"
                checked={wantVision}
                onChange={(e) => setWantVision(e.target.checked)}
              />{' '}
              Let Ask take screenshots when it needs to see the screen
            </label>
          </div>
          <p className="muted">
            {/* A listing says a name is accepted; it does not say the model
                reads images. Only the test answers that. */}
            Screenshot support is confirmed by testing, not by the model name.{' '}
            {capabilitySentence(config)}
          </p>

          {/* ── step 4: test ─────────────────────────────────────────────── */}
          {error ? <p className="error">{error}</p> : null}
          {report ? (
            <p
              className={report.ok ? 'muted' : 'error'}
              data-testid="agent-provider-test-result"
              role="status"
            >
              {reportSentence(report)}
            </p>
          ) : null}

          <div className="row">
            <button
              className="btn btn--primary"
              disabled={busy !== ''}
              onClick={() =>
                void (async () => {
                  if ((await save()) !== null) await test();
                })()
              }
            >
              {busy === 'saving' ? 'Saving…' : busy === 'testing' ? 'Testing…' : 'Save and test'}
            </button>
            <button className="btn" disabled={busy !== ''} onClick={() => void save()}>
              Save without testing
            </button>
            {config.hasKey || config.providerKind ? (
              <button
                className="btn"
                disabled={busy !== ''}
                onClick={() => void disconnect()}
                data-testid="agent-provider-disconnect"
              >
                {busy === 'removing' ? 'Removing…' : 'Disconnect'}
              </button>
            ) : null}
          </div>
          <p className="muted">
            Disconnecting removes the saved key for this endpoint and forgets the provider. Manual
            remote control keeps working, because it never used a provider.
          </p>
        </>
      ) : null}
    </section>
  );
}

/**
 * What is known about capabilities, in one sentence, three-state.
 *
 * Capability only. The checkbox above states the permission, and saying
 * "screenshots work" about a box that is unticked would describe a thing that
 * will not happen (L-286).
 */
export function capabilitySentence(config: AgentConfigDto): string {
  if (config.tools === null && config.vision === null) return 'Nothing has been tested yet.';
  const parts: string[] = [];
  parts.push(config.tools === true ? 'Tool calling works' : 'Tool calling did not work');
  if (config.vision === true) {
    parts.push(
      config.allowScreenshots === true
        ? 'screenshots work'
        : 'screenshots work, but they are turned off above',
    );
  } else if (config.vision === false) {
    parts.push('screenshots did not work, so Ask stays text-only');
  } else {
    parts.push('screenshots untested');
  }
  const when = config.verifiedAt ? ` (checked ${config.verifiedAt.slice(0, 10)})` : '';
  return `${parts.join('; ')}${when}.`;
}

/** The test result as something to act on. */
export function reportSentence(report: ProbeReport): string {
  if (report.message) return report.message;
  if (report.ok && report.vision === 'supported') {
    return `Connected to ${report.origin}. ${report.model} calls tools and reads images.`;
  }
  if (report.ok) return `Connected to ${report.origin}. ${report.model} calls tools.`;
  return `Could not use ${report.origin}.`;
}
