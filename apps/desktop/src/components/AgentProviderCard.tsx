import { useCallback, useEffect, useRef, useState } from 'react';
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
  /** The model a blank field means, or '' when this provider has none we have
   *  checked (L-292). Optional so an older backend still renders. */
  defaultModel?: string;
}

/** What is known about whether Ask can use a model (L-291). */
type Suitability = 'usable' | 'unsuitable' | 'unknown';

interface ModelOption {
  id: string;
  suitability: Suitability;
  reason: string;
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

  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [modelsError, setModelsError] = useState('');
  const [busy, setBusy] = useState<'' | 'saving' | 'testing' | 'listing' | 'removing'>('');
  const [error, setError] = useState('');
  const [report, setReport] = useState<ProbeReport | null>(null);

  const preset = presets.find((p) => p.id === profileId);
  const dialect = preset?.dialect ?? 'anthropic';

  /**
   * What is known about the model in the field right now (L-291).
   *
   * The customer picked a Live Audio id from this very list and every request
   * afterwards failed, because that model is reached over a WebSocket and Ask
   * sends chat completions. The endpoint's own metadata says which models can
   * answer a chat request, so a choice that cannot is refused here — before a
   * request is made, with the reason — rather than surfacing later as a
   * provider error nobody can act on.
   *
   * A typed id is judged the same way, against the same metadata. An id the
   * metadata has never heard of stays open: nothing is known, and the probe
   * is what settles it.
   */
  const chosen = model.trim();
  const chosenOption = chosen
    ? (models?.find((m) => m.id === chosen || m.id.replace(/^.*\//, '') === chosen) ?? null)
    : null;
  const unsuitable = chosenOption?.suitability === 'unsuitable' ? chosenOption : null;
  /** This provider has no default we have checked, so blank is not a choice. */
  const needsExplicitModel = !chosen && preset?.defaultModel === '';

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

  /** Everything that belonged to the old provider. A base URL or model from
   * another origin is not a default for this one. */
  const forgetProvider = (id: string) => {
    const next = presets.find((p) => p.id === id);
    setProfileId(id);
    setBaseUrl(next?.defaultBaseUrl ?? '');
    setModel('');
    setModels(null);
    setReport(null);
    setError('');
  };

  /** Changing provider by hand also drops the key: it belonged to the old
   * destination and is not a credential for this one. */
  const chooseProvider = (id: string) => {
    forgetProvider(id);
    setApiKey('');
  };

  /**
   * What the pasted credential's shape points at, if anything (L-313).
   *
   * This is a **safety** fix wearing a convenience fix's clothes. The
   * catalogue now loads as soon as a credential exists (L-311), and the
   * provider selection starts on Anthropic — so pasting an OpenRouter key on a
   * fresh install sent `sk-or-v1-…` straight to `api.anthropic.com`, a party
   * it does not belong to. Recognising the shape is what stops the key going
   * to the wrong company.
   *
   * `null` is the ordinary answer and changes nothing: an unfamiliar, new or
   * re-shaped key is never refused, and whatever provider the person chose
   * stands. See `presets::recognise`.
   */
  const [recognised, setRecognised] = useState<string | null>(null);
  /** The exact key text an answer has come back for. */
  const [recognisedFor, setRecognisedFor] = useState('');
  /**
   * A key is on screen that nothing has looked at yet.
   *
   * Derived during render rather than held in state, and that is the whole
   * correctness argument: the listing effect and this one run in the same
   * commit, so a `setRecognising(true)` in the effect above is invisible to the
   * effect below, which still sees the value from the render that scheduled
   * them both. Written that way first, and the test caught it — the key went
   * to `api.anthropic.com` exactly as before.
   */
  const keyPending = apiKey.trim() !== '' && apiKey.trim() !== recognisedFor;
  useEffect(() => {
    const key = apiKey.trim();
    if (key === '') {
      setRecognised(null);
      setRecognisedFor('');
      return;
    }
    if (key === recognisedFor) return;
    let alive = true;
    void invoke<string | null>('recognise_api_key', { key })
      .then((id) => {
        if (!alive) return;
        if (id && id !== profileId) forgetProvider(id);
        setRecognised(id ?? null);
      })
      .catch(() => {
        /* Recognition is a convenience. Failing it must not block setup, and
         * the person's own choice of provider is still in force. */
      })
      .finally(() => {
        // Always, including on failure: otherwise a provider that cannot be
        // recognised leaves the listing waiting for ever.
        if (alive) setRecognisedFor(key);
      });
    return () => {
      alive = false;
    };
    // Deliberately not depending on `forgetProvider`: it is rebuilt every
    // render, so re-running on it would re-ask the backend on every keystroke.
  }, [apiKey, recognisedFor, profileId]);

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

  const listModels = useCallback(async () => {
    setBusy('listing');
    setModelsError('');
    try {
      const listed = await invoke<ModelOption[]>('list_agent_models', {
        args: {
          providerKind: dialect,
          baseUrl: baseUrl.trim() || null,
          apiKey: apiKey.trim() || null,
        },
      });
      // Defensive about the shape: an older backend answered with bare ids.
      const options: ModelOption[] = Array.isArray(listed)
        ? listed.map((entry) =>
            typeof entry === 'string'
              ? { id: entry, suitability: 'unknown' as const, reason: '' }
              : entry,
          )
        : [];
      setModels(options);
      if (options.length === 0)
        setModelsError('This endpoint listed no models. Type the id instead.');
    } catch (err) {
      setModels(null);
      setModelsError(`${String(err)}. You can still type the model id.`);
    } finally {
      setBusy('');
    }
  }, [dialect, baseUrl, apiKey]);

  /**
   * Fetch the catalogue as soon as there is a credential to fetch it with,
   * instead of behind a button somebody has to know to press (L-311).
   *
   * Everything that judges a model hangs off this list. With no listing,
   * `models` is null, a typed or pasted id is compared against nothing, and
   * both Save buttons stay live — so the L-291 and L-310 refusals only ever
   * protected a person who had already clicked `List models`. The owner's
   * v0.1.36 install had a batch-only model saved this way.
   *
   * Three conditions, and each is load-bearing:
   *
   *  - a credential exists (typed now, or already saved, or not required).
   *    Listing before then answers 401 and puts an error on screen that the
   *    person has done nothing to deserve.
   *  - `listModels` sets the catalogue back to null when it fails, so "is it
   *    null" cannot be the whole guard or a dead endpoint is called for ever.
   *    One automatic attempt per destination; the button is the manual retry.
   *  - past the provider step, because that is where the model field appears.
   */
  const hasCredential =
    apiKey.trim() !== '' || config?.hasKey === true || preset?.requiresKey === false;
  const listedFor = useRef('');
  const listingTarget = `${dialect}|${baseUrl.trim()}|${apiKey.trim() === '' ? '' : 'key'}`;
  useEffect(() => {
    if (step === 'provider' || !preset?.modelDiscovery || !hasCredential) return;
    // Never list while the shape of a freshly pasted key is still being read
    // (L-313). Listing is what first carries the key off this Mac, and the
    // destination is exactly what recognition is about to correct.
    if (keyPending) return;
    if (models !== null || busy !== '' || listedFor.current === listingTarget) return;
    listedFor.current = listingTarget;
    void listModels();
  }, [step, preset, hasCredential, keyPending, models, busy, listingTarget, listModels]);

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
          {/* Where this key is about to go, before it goes there (L-313).
              Naming the destination is the whole safeguard: the person can see
              that a pasted key moved the provider, and to what. */}
          {recognised ? (
            <p className="muted" data-testid="agent-provider-recognised">
              That looks like a{' '}
              {presets.find((p) => p.id === recognised)?.displayName ?? recognised} key. Requests go
              to <code>{baseUrl}</code>.
            </p>
          ) : null}

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
              {/* Only what Ask can actually use is offered. The rest are
                  listed below with the reason, so a person looking for a name
                  they saw in the provider's console is not left wondering
                  where it went. */}
              {models
                .filter((m) => m.suitability !== 'unsuitable')
                .map((m) => (
                  <option key={m.id} value={m.id} />
                ))}
            </datalist>
          ) : null}
          {models && models.some((m) => m.suitability === 'unsuitable') ? (
            <p className="muted" data-testid="agent-provider-models-filtered">
              {models.filter((m) => m.suitability === 'unsuitable').length} of {models.length}{' '}
              models on this endpoint cannot answer an Ask request and are not offered.
            </p>
          ) : null}
          {unsuitable ? (
            <p className="warn" data-testid="agent-provider-model-unsuitable">
              {unsuitable.reason}
            </p>
          ) : null}
          {needsExplicitModel ? (
            <p className="muted" data-testid="agent-provider-model-required">
              Choose a model. This provider has no default we have checked, and guessing one would
              send a request it cannot answer.
            </p>
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
            {/* A model the endpoint says cannot answer a chat request, or no
                model at all where this provider has no checked default, is
                refused here rather than sent (L-291, L-292). */}
            <button
              className="btn btn--primary"
              disabled={busy !== '' || unsuitable !== null || needsExplicitModel}
              onClick={() =>
                void (async () => {
                  if ((await save()) !== null) await test();
                })()
              }
            >
              {busy === 'saving' ? 'Saving…' : busy === 'testing' ? 'Testing…' : 'Save and test'}
            </button>
            <button
              className="btn"
              disabled={busy !== '' || unsuitable !== null || needsExplicitModel}
              onClick={() => void save()}
            >
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
