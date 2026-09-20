import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

/** Mirrors `InstantConfigDto` in `commands.rs`. The key never comes back. */
export interface InstantConfigDto {
  hasKey: boolean;
  source: 'env' | 'settings' | 'none';
  origin: string;
  problem: string | null;
  /** "model", "lilypad" (Lilypad's own account) or "typesafe" (your own
   *  key) — who runs a whole task (ADR-0020). */
  engine: string;
  /** Whether this Mac can reach Lilypad's own account at all. Not a
   *  statement about the subscription: the backend decides that. */
  hostedAvailable: boolean;
  /** Where hosted requests go — Lilypad's server, not TypeSafe. */
  hostedOrigin: string | null;
}

/**
 * Instant actions (ADR-0019): a TypeSafe key that lets short commands happen
 * in about a second, without waiting for the AI model.
 *
 * What leaves the Mac is said here, on the screen where the key is added, as
 * it is for the provider above; the phone asks separately before any command
 * goes there.
 */
export function InstantActionsCard() {
  const [config, setConfig] = useState<InstantConfigDto | null>(null);

  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<'' | 'saving' | 'removing'>('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    invoke<InstantConfigDto>('get_instant_config')
      .then(setConfig)
      .catch((err: unknown) => setError(String(err)));
  }, []);

  const engine = config?.engine ?? 'model';
  const chooseEngine = async (next: string) => {
    setError(null);
    try {
      await invoke('set_ask_engine', { engine: next });
      setConfig(await invoke<InstantConfigDto>('get_instant_config'));
    } catch (err) {
      setError(String(err));
    }
  };

  const save = async () => {
    setBusy('saving');
    setError(null);
    setSaved(false);
    try {
      setConfig(await invoke<InstantConfigDto>('set_instant_key', { apiKey: key }));
      setKey('');
      setSaved(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy('');
    }
  };

  const remove = async () => {
    setBusy('removing');
    setError(null);
    setSaved(false);
    try {
      setConfig(await invoke<InstantConfigDto>('forget_instant_key'));
    } catch (err) {
      // A removal that failed says so; the key may still be in the keychain.
      setError(`The key could not be removed: ${String(err)}`);
    } finally {
      setBusy('');
    }
  };

  const on = config?.hasKey === true;

  return (
    <section className="control__approve" data-testid="instant-card">
      <p className="control__approve-title">
        <strong>Instant actions</strong>
        <span className="chip" data-testid="instant-state">
          {config === null ? 'Checking…' : on ? (config.problem ? 'Key refused' : 'On') : 'Off'}
        </span>
      </p>
      <p className="muted">
        Short commands like &ldquo;scroll down&rdquo;, &ldquo;click Compose&rdquo; or &ldquo;open
        Safari&rdquo; happen in about a second, without waiting for the AI model. TypeSafe&apos;s
        Jev model works out which action you mean. It receives your command, the name of the app in
        front, the names of actionable controls on screen (including buttons, links, fields, rows,
        and menu items), and matching installed-app names when you name an app &mdash; never a
        screenshot and never what is typed in a field. Anything longer goes to the provider above,
        as usual.
      </p>
      {on ? (
        <p className="muted" data-testid="instant-origin">
          Commands go to <code>{config.origin}</code>.
        </p>
      ) : null}
      {config?.source === 'env' ? (
        <p className="muted" data-testid="instant-env">
          <em>A developer environment override supplies the key.</em>
        </p>
      ) : null}
      {config?.problem ? (
        <p className="error" data-testid="instant-problem">
          {config.problem}
        </p>
      ) : null}
      <div className="row" data-testid="instant-engine">
        <label>
          <input
            type="radio"
            name="ask-engine"
            checked={engine === 'model'}
            onChange={() => void chooseEngine('model')}
          />{' '}
          Your AI provider runs tasks; TypeSafe only does short commands
        </label>
        {config?.hostedAvailable ? (
          <label data-testid="instant-engine-lilypad">
            <input
              type="radio"
              name="ask-engine"
              checked={engine === 'lilypad'}
              onChange={() => void chooseEngine('lilypad')}
            />{' '}
            <strong>Lilypad runs whole tasks</strong> <span className="chip">Pro</span> &mdash; no
            key needed. What Ask reads from your screen goes to Lilypad
            {config.hostedOrigin ? (
              <>
                {' '}
                (<code>{config.hostedOrigin}</code>)
              </>
            ) : null}
            , which asks the model on our account. Still no screenshots, and it cannot write new
            text or read a page back. 25 tasks a day.
          </label>
        ) : null}
        {on ? (
          <label data-testid="instant-engine-typesafe">
            <input
              type="radio"
              name="ask-engine"
              checked={engine === 'typesafe'}
              onChange={() => void chooseEngine('typesafe')}
            />{' '}
            Your own TypeSafe key runs whole tasks, one step at a time, straight to TypeSafe (no
            screenshots; it cannot write text or read pages back)
          </label>
        ) : null}
      </div>
      <div className="row">
        <input
          type="password"
          aria-label="TypeSafe API key"
          placeholder={
            config?.source === 'settings'
              ? 'A key is saved. Enter a new one to replace it'
              : 'TypeSafe API key'
          }
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoComplete="off"
        />
      </div>
      {error ? (
        <p className="error" role="alert" data-testid="instant-error">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="muted" role="status" data-testid="instant-saved">
          TypeSafe accepted the key and it is saved. Your phone asks once before sending anything
          there.
        </p>
      ) : null}
      <div className="row">
        <button
          className="btn btn--primary"
          disabled={busy !== '' || key.trim() === ''}
          onClick={() => void save()}
        >
          {busy === 'saving' ? 'Checking…' : 'Check and save'}
        </button>
        {config?.source === 'settings' ? (
          <button
            className="btn"
            disabled={busy !== ''}
            onClick={() => void remove()}
            data-testid="instant-remove"
          >
            {busy === 'removing' ? 'Removing…' : 'Turn off'}
          </button>
        ) : null}
      </div>
      <p className="muted">
        Keys come from console.typesafe.ai. Yours is stored in the macOS keychain, never in a file.
      </p>
    </section>
  );
}
