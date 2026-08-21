import { useAppState } from '../lib/useAppState';
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
 * Developer/support diagnostics — the "Plugin health" list that used to sit
 * at the bottom of the approve/session window, visible to every user during
 * normal operation. Moved to its own window, reachable only via the tray's
 * "Diagnostics…" item, so a security decision (approve/deny) is never shown
 * next to what reads as unfinished debug output. See
 * `docs/audit/m3/desktop-ux.md` Finding 2.
 */
export function Diagnostics() {
  const state = useAppState();

  return (
    <div className="page diagnostics">
      <h1>Diagnostics</h1>
      <p className="muted">Support/developer information — not shown during normal use.</p>

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
