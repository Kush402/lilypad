import { useCallback, useEffect, useState } from 'react';
import { api, type TrustedPairDto } from '../lib/tauri';
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
  // "Trust this device" (M5.4): default ON — the pairing ceremony (scan +
  // explicit approve) IS the trust decision; unchecking covers one-off
  // sessions on devices you don't own.
  const [trust, setTrust] = useState(true);

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
          <label className="row trust-row">
            <input
              type="checkbox"
              checked={trust}
              onChange={(e) => setTrust(e.target.checked)}
            />
            <span>
              Trust this device <span className="muted">— reconnects without a QR scan</span>
            </span>
          </label>
          <div className="row">
            <button className="btn btn--primary" onClick={() => void api.approve(trust)}>
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

      <TrustedDevices />
    </div>
  );
}

function lastConnectedLabel(iso: string | null): string {
  if (!iso) return 'never connected';
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return 'connected just now';
  if (mins < 60) return `last connected ${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `last connected ${hours}h ago`;
  return `last connected ${Math.round(hours / 24)}d ago`;
}

/**
 * Trusted devices dashboard (M5.4) — every phone paired with this Mac, with
 * the per-pair "connect without approval" toggle and Revoke. This window is
 * the single control point for Lilypad's trust relationships.
 */
function TrustedDevices() {
  const [pairs, setPairs] = useState<TrustedPairDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api
      .listTrustedDevices()
      .then((p) => {
        setPairs(p.filter((pair) => !pair.revoked));
        setError(null);
      })
      .catch(() => setError('Could not load trusted devices (backend offline?)'));
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 15_000);
    return () => clearInterval(id);
  }, [refresh]);

  const toggle = (pair: TrustedPairDto) => {
    void api
      .setPairAutoApprove(pair.pairId, !pair.autoApprove)
      .then(refresh)
      .catch(() => setError('Update failed — is the backend running?'));
  };

  const revoke = (pair: TrustedPairDto) => {
    if (!window.confirm('Revoke this phone? It will need a fresh QR pairing to reconnect.')) {
      return;
    }
    void api
      .revokePair(pair.pairId)
      .then(refresh)
      .catch(() => setError('Revoke failed — is the backend running?'));
  };

  return (
    <section className="control__devices">
      <h2 className="section-title">Trusted devices</h2>
      {error ? <p className="muted">{error}</p> : null}
      {pairs !== null && pairs.length === 0 ? (
        <p className="muted">
          No trusted phones yet. Pair once with the QR and leave “Trust this device” checked.
        </p>
      ) : null}
      {(pairs ?? []).map((pair) => (
        <div key={pair.pairId} className="device-row">
          <div className="device-row__info">
            <span className="device-row__name">{pair.displayName ?? 'Phone'}</span>
            <span className="muted device-row__meta">
              {lastConnectedLabel(pair.lastConnectedAt)}
            </span>
          </div>
          <label className="device-row__toggle" title="Connect without approval">
            <input
              type="checkbox"
              checked={pair.autoApprove}
              onChange={() => toggle(pair)}
            />
            <span>Auto-connect</span>
          </label>
          <button className="btn btn--danger btn--small" onClick={() => revoke(pair)}>
            Revoke
          </button>
        </div>
      ))}
    </section>
  );
}
