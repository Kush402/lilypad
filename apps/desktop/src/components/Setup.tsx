import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { AgentProviderCard } from './AgentProviderCard';

type PermissionKind = 'screen_capture' | 'accessibility';
const KINDS: readonly PermissionKind[] = ['screen_capture', 'accessibility'];

interface PermissionStatusDto {
  screen_capture: boolean;
  accessibility: boolean;
}

const COPY: Record<PermissionKind, { label: string; body: string }> = {
  screen_capture: {
    label: 'Screen Recording',
    body: 'Lilypad needs Screen Recording to show your screen to the phone that connects to it.',
  },
  accessibility: {
    label: 'Accessibility',
    body: 'Lilypad needs Accessibility to move your mouse and type on your behalf.',
  },
};

/// Consecutive still-false polls (after the user demonstrably opened
/// Settings for that permission) before offering a restart. Some TCC grants
/// — notably Accessibility on non-notarized dev builds — only take effect
/// after the process relaunches; guessing "probably needs a restart" off a
/// timer alone would be wrong far more often than this.
const RELAUNCH_THRESHOLD = 3;

/**
 * First-run permission wizard. Previously the ONLY signal a permission
 * problem existed was a passive TCC preflight surfacing as a raw
 * "degraded: ..." string buried in a debug list — no active request, no
 * remediation path, no way to know a relaunch might be needed. This window:
 *
 *  1. Explains, per permission, why it's needed.
 *  2. "Grant" calls the PROMPTING FFI variant (`request_permission`), not
 *     the passive preflight the rest of the app uses.
 *  3. Live-polls via `lilypad://permission` (a real Tauri event the Rust side
 *     emits — see `commands::show_setup` — not another frontend timer).
 *  4. "Open Settings" deep-links straight to the right row.
 *  5. Offers a Restart once a permission the user demonstrably went to
 *     Settings for still reads ungranted after several consecutive polls.
 *
 * See `docs/audit/m3/desktop-ux.md` Finding 1.
 */
export function Setup() {
  const [status, setStatus] = useState<PermissionStatusDto>({
    screen_capture: false,
    accessibility: false,
  });
  const [needsRestart, setNeedsRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const openedSettingsFor = useRef<Record<PermissionKind, boolean>>({
    screen_capture: false,
    accessibility: false,
  });
  const staleCount = useRef<Record<PermissionKind, number>>({
    screen_capture: 0,
    accessibility: 0,
  });

  useEffect(() => {
    let alive = true;

    invoke<PermissionStatusDto>('get_permission_status')
      .then((s) => {
        if (alive) setStatus(s);
      })
      .catch(() => {
        /* not running inside Tauri */
      });

    let unlisten: (() => void) | undefined;
    listen<PermissionStatusDto>('lilypad://permission', (event) => {
      if (!alive) return;
      const next = event.payload;
      setStatus(next);
      for (const kind of KINDS) {
        if (next[kind]) {
          staleCount.current[kind] = 0;
        } else if (openedSettingsFor.current[kind]) {
          staleCount.current[kind] += 1;
          if (staleCount.current[kind] >= RELAUNCH_THRESHOLD) {
            setNeedsRestart(true);
          }
        }
      }
    })
      .then((fn) => {
        if (alive) {
          unlisten = fn;
        } else {
          fn();
        }
      })
      .catch(() => {
        /* not running inside Tauri */
      });

    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  const grant = async (kind: PermissionKind) => {
    const granted = await invoke<boolean>('request_permission', { kind });
    setStatus((prev) => ({ ...prev, [kind]: granted }));
  };

  const openSettings = async (kind: PermissionKind) => {
    openedSettingsFor.current[kind] = true;
    await invoke('open_permission_settings', { kind });
  };

  const restart = async () => {
    setRestarting(true);
    await invoke('restart_app');
  };

  const allGranted = status.screen_capture && status.accessibility;

  return (
    <div className="page setup">
      <h1>Set up Lilypad</h1>
      <p className="muted">Two permissions are needed before you can pair a phone.</p>

      {needsRestart ? (
        <section className="control__approve">
          <p>
            <strong>Finish setup</strong> — Lilypad needs to restart once to pick up the new
            permission.
          </p>
          <div className="row">
            <button
              className="btn btn--primary"
              disabled={restarting}
              onClick={() => void restart()}
            >
              {restarting ? 'Restarting…' : 'Restart Lilypad'}
            </button>
          </div>
        </section>
      ) : null}

      {KINDS.map((kind) => {
        const granted = status[kind];
        return (
          <section key={kind} className="control__approve">
            <p className="control__approve-title">
              <strong>{COPY[kind].label}</strong>
              {granted ? <span className="chip">Granted</span> : null}
            </p>
            <p className="muted">{COPY[kind].body}</p>
            {!granted ? (
              <div className="row">
                <button className="btn btn--primary" onClick={() => void grant(kind)}>
                  Grant
                </button>
                <button className="btn" onClick={() => void openSettings(kind)}>
                  Open Settings
                </button>
              </div>
            ) : null}
          </section>
        );
      })}

      <AgentProviderCard />

      {allGranted ? (
        <section className="control__active">
          <p>✓ All set — you can start pairing now.</p>
          <div className="row">
            <button className="btn btn--primary" onClick={() => void getCurrentWindow().close()}>
              Continue
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
