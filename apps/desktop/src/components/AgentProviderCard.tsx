import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface AgentConfigDto {
  providerKind: string | null;
  model: string | null;
  baseUrl: string | null;
  vision: boolean;
  hasKey: boolean;
  source: 'env' | 'settings' | 'none';
}

/**
 * The Ask assistant's provider settings — lives in the Setup window beside the
 * permission cards. Non-secret selection persists in the app-support JSON;
 * the API key goes straight to the macOS keychain and is never echoed back
 * (only `hasKey`). An active env override ("dev mode") is surfaced instead of
 * silently ignoring what the user types here.
 */
export function AgentProviderCard() {
  const [config, setConfig] = useState<AgentConfigDto | null>(null);
  const [kind, setKind] = useState('anthropic');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    invoke<AgentConfigDto>('get_agent_config')
      .then((c) => {
        setConfig(c);
        if (c.providerKind) setKind(c.providerKind);
        setModel(c.model ?? '');
        setBaseUrl(c.baseUrl ?? '');
      })
      .catch(() => {
        /* not running inside Tauri */
      });
  }, []);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const next = await invoke<AgentConfigDto>('set_agent_config', {
        args: {
          providerKind: kind,
          model: model.trim() || null,
          baseUrl: baseUrl.trim() || null,
          vision: null,
          apiKey: apiKey.trim() || null,
        },
      });
      setConfig(next);
      setApiKey(''); // never keep the secret in component state post-save
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const configured = config?.source !== 'none';

  return (
    <section className="control__approve" data-testid="agent-provider-card">
      <p className="control__approve-title">
        <strong>AI Assistant (Ask)</strong>
        {configured ? <span className="chip">Configured</span> : null}
      </p>
      <p className="muted">
        Powers the phone&apos;s Ask feature. Your API key is stored in the macOS keychain, never in
        a file.
      </p>

      {config?.source === 'env' ? (
        <p className="muted">
          <em>
            A developer environment override is active. It takes precedence over these settings.
          </em>
        </p>
      ) : null}

      <div className="row">
        <label className="muted" htmlFor="agent-kind">
          Provider
        </label>
        <select id="agent-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="anthropic">Anthropic</option>
          <option value="openai_compat">OpenAI-compatible (OpenAI, Ollama, OpenRouter…)</option>
        </select>
      </div>
      <div className="row">
        <input
          aria-label="Model, blank for the provider default"
          placeholder="Model (blank = provider default)"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
      </div>
      {kind === 'openai_compat' ? (
        <div className="row">
          <input
            aria-label="Base URL"
            placeholder="Base URL, e.g. http://localhost:11434/v1"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </div>
      ) : null}
      <div className="row">
        <input
          type="password"
          aria-label="API key"
          placeholder={config?.hasKey ? 'API key saved. Enter a new one to replace it' : 'API key'}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          autoComplete="off"
        />
      </div>

      {error ? <p className="error">{error}</p> : null}

      <div className="row">
        <button className="btn btn--primary" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </section>
  );
}
