import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type TrustedPairDto } from '../lib/tauri';
import { useAppState } from '../lib/useAppState';
import { useLiveResource } from '../lib/useLiveResource';
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

/** Ticks every 5s so relative timestamps stay current — a purely client-side
 * re-render, never a network poll. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The Lilypad dashboard — the single control surface for the whole app:
 * live session status + approve/deny, trusted-device management, and a
 * system panel (this Mac's reachability, OS permissions, the Ask AI provider,
 * and launch-at-login). Every data surface refreshes race-safely through
 * `useLiveResource`, so concurrent refreshes (events, polls, reconciles after
 * a mutation) can never flicker stale data.
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
    <div className="page control dashboard">
      <header className="control__header">
        <h1>Lilypad</h1>
        <div className="control__header-actions">
          <span className={`badge badge--${session}`}>{STATUS_LABEL[session]}</span>
          {/* Mirrors the tray's `show_qr.set_enabled(!(active || connecting))`
           * — enabled whenever a session isn't already in progress (idle,
           * pairing, and awaiting_approval all still allow pairing a new
           * device; connecting is a session already underway). */}
          <button
            className="btn btn--primary btn--icon"
            disabled={session === 'active' || session === 'connecting'}
            title={
              session === 'active' || session === 'connecting'
                ? 'Disconnect the current session to pair a new device'
                : 'Pair a new device'
            }
            aria-label="Pair a new device"
            onClick={() => void api.showQrWindow()}
          >
            +
          </button>
        </div>
      </header>

      <p className="dashboard__subtitle muted">{sessionSummary(session)}</p>

      {session === 'awaiting_approval' ? (
        <section className="control__approve card">
          <p className="control__approve-title">
            <strong>{pending?.device_name ?? 'An unknown device'}</strong> wants to view and control
            this Mac
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
            <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />
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

      {session === 'connecting' ? (
        <section className="control__connecting card">
          <p className="muted">
            <span className="spinner" aria-hidden /> Establishing a secure connection…
          </p>
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

      {session === 'active' ? (
        <section className="control__active card">
          <p className="muted">A device is controlling this Mac right now.</p>
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
      <SystemPanel backendUrl={state?.backend_base_url ?? null} />
    </div>
  );
}

function sessionSummary(session: string): string {
  switch (session) {
    case 'active':
      return 'A device is connected and in control.';
    case 'awaiting_approval':
      return 'A device is asking to connect.';
    case 'connecting':
      return 'Connecting to the device…';
    case 'pairing':
      return 'Waiting for a phone to scan the QR code.';
    default:
      return 'Ready. Trusted devices can connect anytime.';
  }
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

/** Same relative-time shape as `lastConnectedLabel`, worded for the
 * expanded panel's "paired" line instead of "last connected". */
function pairedLabel(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return 'paired just now';
  if (mins < 60) return `paired ${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `paired ${hours}h ago`;
  return `paired ${Math.round(hours / 24)}d ago`;
}

/**
 * Trusted devices — every phone paired with this Mac, with the per-pair
 * "connect without approval" toggle and Revoke. The list refreshes
 * race-safely (poll + reconcile-after-mutation can't clobber each other).
 *
 * Each row is a click-to-expand accordion rather than always-inline: the
 * collapsed row (name + last-connected) is the scannable list, and the
 * fingerprint/paired-date/toggle/revoke only render for the one expanded
 * row. Expansion state is keyed by `pair.pairId` (a stable string, not
 * array index), so a 15s poll refresh — which hands back a brand-new
 * `pairs` array reference every time — never collapses an open row.
 */
function TrustedDevices() {
  const {
    value: pairs,
    error,
    refresh,
  } = useLiveResource(() =>
    api.listTrustedDevices().then((p) => p.filter((pair) => !pair.revoked)),
  );
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Which pair's Revoke is in its "are you sure" second step. `window.confirm`
  // used to gate this, but it returns falsy in Tauri's wry webview — the
  // `if (!window.confirm(...)) return;` always bailed, so `revokePair` was
  // NEVER called (proven: the backend's revoke audit log never fired). An
  // inline two-step confirm works deterministically in any webview.
  const [confirmingRevokeId, setConfirmingRevokeId] = useState<string | null>(null);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 15_000);
    return () => clearInterval(id);
  }, [refresh]);

  const toggle = (pair: TrustedPairDto) => {
    void api.setPairAutoApprove(pair.pairId, !pair.autoApprove).then(refresh).catch(refresh);
  };

  const revoke = (pair: TrustedPairDto) => {
    setConfirmingRevokeId(null);
    void api.revokePair(pair.pairId).then(refresh).catch(refresh);
  };

  return (
    <section className="control__devices card">
      <h2 className="section-title">Trusted devices</h2>
      {error ? (
        <p className="muted">Couldn’t load trusted devices — is the backend running?</p>
      ) : null}
      {pairs !== null && pairs.length === 0 ? (
        <p className="muted">
          No trusted phones yet. Pair once with the QR and leave “Trust this device” checked.
        </p>
      ) : null}
      {(pairs ?? []).map((pair) => {
        const expanded = expandedId === pair.pairId;
        return (
          <div key={pair.pairId} className={`device-row${expanded ? ' device-row--expanded' : ''}`}>
            <div
              className="device-row__summary"
              role="button"
              tabIndex={0}
              aria-expanded={expanded}
              onClick={() => {
                // Collapsing mid-confirm drops the pending confirm — the
                // confirm UI only renders inside the expanded detail, so this
                // just prevents a stale flag from lingering unseen.
                if (expanded) setConfirmingRevokeId(null);
                setExpandedId(expanded ? null : pair.pairId);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  if (expanded) setConfirmingRevokeId(null);
                  setExpandedId(expanded ? null : pair.pairId);
                }
              }}
            >
              <div className="device-row__info">
                <span className="device-row__name">{pair.displayName ?? 'Phone'}</span>
                <span className="muted device-row__meta">
                  {lastConnectedLabel(pair.lastConnectedAt)}
                </span>
              </div>
              <span className="device-row__chevron" aria-hidden>
                {expanded ? '▾' : '▸'}
              </span>
            </div>
            {expanded ? (
              <div className="device-row__detail">
                <div className="device-row__fingerprint">
                  <span className="muted device-row__meta">Fingerprint</span>
                  <span className="mono">{pair.mobileFingerprint}</span>
                </div>
                <p className="muted device-row__meta">{pairedLabel(pair.createdAt)}</p>
                <label className="device-row__toggle" title="Connect without approval">
                  <input type="checkbox" checked={pair.autoApprove} onChange={() => toggle(pair)} />
                  <span>Auto-connect</span>
                </label>
                {confirmingRevokeId === pair.pairId ? (
                  <div className="revoke-confirm">
                    <p className="muted device-row__meta">
                      Revoke this phone? It will need a fresh QR pairing to reconnect.
                    </p>
                    <div className="row revoke-confirm__actions">
                      <button
                        className="btn btn--danger btn--small"
                        onClick={(e) => {
                          e.stopPropagation();
                          revoke(pair);
                        }}
                      >
                        Confirm
                      </button>
                      <button
                        className="btn btn--ghost btn--small"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmingRevokeId(null);
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    className="btn btn--danger btn--small"
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmingRevokeId(pair.pairId);
                    }}
                  >
                    Revoke
                  </button>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

/**
 * System panel — everything about THIS Mac in one place: backend
 * reachability, the two OS permissions Lilypad needs, the Ask AI provider,
 * and launch-at-login. Read-only status with an "Open Setup" affordance for
 * editing; refreshes on mount and whenever the window regains focus (so an
 * externally-granted permission shows up without a manual reload).
 */
function SystemPanel({ backendUrl }: { backendUrl: string | null }) {
  const perms = useLiveResource(api.getPermissionStatus);
  const agent = useLiveResource(api.getAgentConfig);
  const login = useLiveResource(api.getLoginItemEnabled);

  const refreshAll = useCallback(() => {
    perms.refresh();
    agent.refresh();
    login.refresh();
  }, [perms, agent, login]);

  useEffect(() => {
    refreshAll();
    window.addEventListener('focus', refreshAll);
    return () => window.removeEventListener('focus', refreshAll);
  }, [refreshAll]);

  // Optimistic login-item toggle, reconciled race-safely by `login.refresh()`.
  const [loginOverride, setLoginOverride] = useState<boolean | null>(null);
  const overrideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loginEnabled = loginOverride ?? login.value ?? false;
  const setLogin = (next: boolean) => {
    setLoginOverride(next);
    if (overrideTimer.current) clearTimeout(overrideTimer.current);
    void api
      .setLoginItemEnabled(next)
      .catch(() => {})
      .finally(() => {
        login.refresh();
        // Clear the optimistic override shortly after so server truth wins.
        overrideTimer.current = setTimeout(() => setLoginOverride(null), 400);
      });
  };
  useEffect(() => () => void (overrideTimer.current && clearTimeout(overrideTimer.current)), []);

  const agentSummary = () => {
    const a = agent.value;
    if (!a || a.source === 'none') return 'Not configured';
    const model = a.model ?? 'default model';
    const src = a.source === 'env' ? ' (env override)' : '';
    return `${model}${a.vision ? ' · vision' : ''}${src}`;
  };

  return (
    <section className="control__system card">
      <div className="section-title-row">
        <h2 className="section-title">This Mac</h2>
        <button className="btn btn--small" onClick={() => void api.showSetup()}>
          Open Setup
        </button>
      </div>

      <StatusRow
        label="Backend"
        ok={backendUrl != null}
        value={backendUrl ? hostOf(backendUrl) : 'unknown'}
      />
      <StatusRow
        label="Screen Recording"
        ok={perms.value?.screen_capture ?? false}
        value={perms.value?.screen_capture ? 'Granted' : 'Needed'}
      />
      <StatusRow
        label="Accessibility"
        ok={perms.value?.accessibility ?? false}
        value={perms.value?.accessibility ? 'Granted' : 'Needed'}
      />
      <StatusRow
        label="Ask AI"
        ok={(agent.value?.source ?? 'none') !== 'none'}
        value={agentSummary()}
      />

      <label className="row trust-row system-toggle">
        <input
          type="checkbox"
          checked={loginEnabled}
          onChange={(e) => setLogin(e.target.checked)}
        />
        <span>
          Launch at login <span className="muted">— stay ready for trusted devices</span>
        </span>
      </label>
    </section>
  );
}

function StatusRow({ label, ok, value }: { label: string; ok: boolean; value: string }) {
  return (
    <div className="status-row">
      <span className={`status-dot status-dot--${ok ? 'ok' : 'warn'}`} aria-hidden />
      <span className="status-row__label">{label}</span>
      <span className="status-row__value muted">{value}</span>
    </div>
  );
}
