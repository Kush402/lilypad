import { useCallback, useEffect, useState } from 'react';
import { useAppState } from '../lib/useAppState';
import type { AppStateDto } from '../lib/tauri';
import { SoftwareUpdate } from './SoftwareUpdate';

/** Consumer-facing labels for what were internal plugin names before the M3
 * architecture pass deleted the plugin-host layer entirely — the three
 * entries `crate::health::plugin_health()` reports today are the two real
 * OS permissions plus encoder status, so this map is mostly identity, but
 * kept as a map (not raw passthrough) so any future renamed/added key gets a
 * deliberate label instead of a raw Rust identifier leaking into the UI. */
const HEALTH_LABEL: Record<string, string> = {
  ScreenCapture: 'Screen Recording',
  Accessibility: 'Accessibility',
  Encoder: 'Video encoder',
};

/**
 * What ICE settled on, in words rather than in candidate types.
 *
 * The three cases are the three that mean something different: whether the
 * media left the network, and whether it went through the relay — which is the
 * one that costs bandwidth and adds a hop. Everything else about a session
 * looks identical from here.
 */
const PATH_LABEL: Record<string, string> = {
  lan: 'Direct, over your local network',
  direct: 'Direct, over the internet',
  relay: 'Relayed through Lilypad’s TURN server',
};

/**
 * Whether a phone can ring this Mac right now, in words.
 *
 * This is the state that was invisible when it mattered most: on 2026-08-22 a
 * Mac spent six hours refusing its own presence registration while the
 * dashboard said "Linked" and the phone said "the laptop is offline" — both
 * true, neither the one a person needed. The dashboard shows the remedy and
 * says nothing while things are fine; this window is where the mechanism
 * belongs.
 */
const PRESENCE_LABEL: Record<string, string> = {
  starting: 'Starting up',
  connecting: 'Connecting to Lilypad',
  online: 'Reachable — a phone can ring this Mac',
  unreachable: 'Cannot reach Lilypad’s server',
  refused: 'Lilypad refused this Mac — it is unlinked, revoked, or has no key',
  no_identity: 'This Mac has no saved key, so it cannot be reached',
};

/**
 * Everything above, as text a person can paste into an email.
 *
 * A support window whose contents can only be retyped is a support window for
 * people who can already read a uuid aloud. `pnpm support <email>` covers the
 * server side; this is the half only the customer's own machine knows.
 */
export function diagnosticsReport(
  state: AppStateDto,
  version: string,
  logPath?: string | null,
): string {
  const health = Object.entries(state.plugin_health)
    .map(([name, value]) => `  ${HEALTH_LABEL[name] ?? name}: ${value}`)
    .join('\n');
  return [
    'Lilypad diagnostics',
    `version: ${version}`,
    `device: ${state.device_id}`,
    `backend: ${state.backend_base_url}`,
    `reachable: ${PRESENCE_LABEL[state.presence.state] ?? state.presence.state}`,
    `session: ${state.session}`,
    `room: ${state.current_room_id ?? 'none'}`,
    // Only when there is a choice to report. On a one-screen Mac this line
    // would say the same thing in every report ever sent, which is the
    // definition of noise in a support paste.
    ...(state.shared_display ? [`showing: ${state.shared_display}`] : []),
    `last connection: ${
      state.connection_path
        ? (PATH_LABEL[state.connection_path] ?? state.connection_path)
        : 'none yet'
    }`,
    // Named in the report because the next question after reading one of
    // these is always "can you send the log" — and the answer has to be a
    // path, not an instruction to go hunting in ~/Library.
    `log: ${logPath ?? 'not being written'}`,
    'health:',
    health || '  (none reported)',
  ].join('\n');
}

/**
 * Developer/support diagnostics — the "Plugin health" list that used to sit
 * at the bottom of the approve/session window, visible to every user during
 * normal operation. Moved to its own window, reachable only via the tray's
 * "Diagnostics…" item, so a security decision (approve/deny) is never shown
 * next to what reads as unfinished debug output. See
 * `docs/audit/m3/desktop-ux.md` Finding 2.
 */
export function Diagnostics() {
  const state = useAppState();
  const [copied, setCopied] = useState(false);
  const [logPath, setLogPath] = useState<string | null>(null);

  useEffect(() => {
    // Best-effort: a missing path is rendered as such, and must never stop the
    // rest of this window from rendering.
    void import('../lib/tauri')
      .then((m) => m.api.logFilePath())
      .then(setLogPath)
      .catch(() => setLogPath(null));
  }, []);

  const copy = useCallback(async () => {
    if (!state) return;
    // `navigator.clipboard` rather than a Tauri plugin: the window is a
    // webview, this is one call, and a dependency that ships a permission
    // surface to save it is a dependency to patch forever.
    const version = await import('../lib/tauri').then((m) => m.updater.currentVersion());
    await navigator.clipboard.writeText(diagnosticsReport(state, version, logPath));
    setCopied(true);
  }, [state, logPath]);

  return (
    <div className="page diagnostics">
      <h1>Diagnostics</h1>
      <p className="muted">Support/developer information — not shown during normal use.</p>

      <div className="row">
        <button
          className="btn"
          data-testid="copy-diagnostics"
          disabled={!state}
          onClick={() => void copy()}
        >
          {copied ? 'Copied' : 'Copy for support'}
        </button>
      </div>
      {/* The button said "for support" and named no support. Someone who has
          copied a report and has nowhere to send it has not been helped —
          this is the only place either app states the address, which is
          otherwise only in the website's footer. */}
      <p className="muted" data-testid="support-address">
        Send it to <strong>support@takedia.com</strong>, with what you were doing when it went
        wrong.
      </p>

      <SoftwareUpdate variant="panel" />

      <section className="debug">
        <h2>Health</h2>
        <ul className="debug__list">
          {state
            ? Object.entries(state.plugin_health).map(([name, health]) => (
                <li key={name}>
                  <span>{HEALTH_LABEL[name] ?? name}</span>
                  <span className={health.startsWith('ok') ? 'ok' : 'down'}>{health}</span>
                </li>
              ))
            : null}
        </ul>
      </section>

      {state ? (
        <section className="debug">
          <h2>Last connection</h2>
          <ul className="debug__list">
            <li>
              <span>Reachable by a phone</span>
              <span data-testid="presence-state">
                {PRESENCE_LABEL[state.presence.state] ?? state.presence.state}
              </span>
            </li>
            <li>
              <span>Path</span>
              <span data-testid="connection-path">
                {state.connection_path
                  ? // An unknown value is shown raw rather than hidden: a new
                    // path type reaching the UI should be visible, not silently
                    // rendered as "no session yet".
                    (PATH_LABEL[state.connection_path] ?? state.connection_path)
                  : 'No session has connected yet'}
              </span>
            </li>
          </ul>
        </section>
      ) : null}

      <section className="debug">
        <h2>Log</h2>
        <ul className="debug__list">
          <li>
            <span>File</span>
            <span data-testid="log-path" className="mono">
              {logPath ?? 'Not being written'}
            </span>
          </li>
        </ul>
        <div className="row">
          <button
            className="btn"
            data-testid="reveal-log"
            disabled={!logPath}
            onClick={() => {
              void import('../lib/tauri').then((m) => m.api.revealLogFile());
            }}
          >
            Show in Finder
          </button>
        </div>
      </section>

      {state ? (
        <p className="muted mono">
          device: {state.device_id}
          <br />
          backend: {state.backend_base_url}
        </p>
      ) : null}
    </div>
  );
}
