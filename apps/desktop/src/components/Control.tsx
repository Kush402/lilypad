import { useEffect, useState } from 'react';
import { api } from '../lib/tauri';
import { useAppState } from '../lib/useAppState';
import { STATUS_LABEL } from '../lib/status';

const SCOPE_LABEL: Record<string, string> = {
  view: 'View',
  control: 'Control',
};

function timeSince(epochMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - epochMs) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m ago`;
}

/** Ticks every 5s so "requesting since Xs ago" stays current — a purely
 * client-side re-render, not a network poll (Finding 8 is about not polling
 * the BACKEND on a timer; this never calls into Rust at all). */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * The approve/deny + live-session control window.
 *
 * Previously rendered the approve prompt as one fixed sentence
 * ("A phone is requesting to view and control this laptop") regardless of
 * which device asked or what it actually requested, and always rendered a
 * "Plugin health" debug dump underneath — the single largest trust decision
 * in the product ("should I let this control my laptop right now") shown
 * with less information than a Bluetooth pairing dialog, right next to
 * developer diagnostics. `AppState.pending_request` (populated from
 * `SessionEvent::PairRequested`, previously discarded via a `{ .. }`
 * wildcard) now drives this screen; the diagnostics view moved to its own
 * window (`Diagnostics.tsx`, tray ▸ "Diagnostics…"). See
 * `docs/audit/m3/desktop-ux.md` Finding 2.
 */
export function Control() {
  const state = useAppState();
  const now = useNow(5_000);
  const session = state?.session ?? 'idle';
  const pending = state?.pending_request ?? null;

  return (
    <div className="page control">
      <header className="control__header">
        <h1>Lilypad session</h1>
        <span className={`badge badge--${session}`}>{STATUS_LABEL[session]}</span>
      </header>

      {session === 'awaiting_approval' ? (
        <section className="control__approve">
          <p className="control__approve-title">
            <strong>{pending?.device_name ?? 'An unknown device'}</strong> wants to view and
            control this Mac
          </p>
          {pending && pending.requested_scopes.length > 0 ? (
            <div className="row scope-row">
              {pending.requested_scopes.map((scope) => (
                <span key={scope} className="chip">
                  {SCOPE_LABEL[scope] ?? scope}
                </span>
              ))}
            </div>
          ) : null}
          {pending ? (
            <p className="muted">requesting since {timeSince(pending.requested_at, now)}</p>
          ) : null}
          <div className="row">
            <button className="btn btn--primary" onClick={() => void api.approve()}>
              Approve
            </button>
            <button className="btn btn--danger" onClick={() => void api.deny()}>
              Deny
            </button>
          </div>
        </section>
      ) : null}

      {session === 'active' ? (
        <section className="control__active">
          <p className="muted">Streaming + input arrive in M2–M4. You are in control.</p>
          <div className="row">
            <button className="btn" onClick={() => void api.disconnect()}>
              Disconnect
            </button>
            <button className="btn btn--danger" onClick={() => void api.panic()}>
              ⛔ Panic
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
