import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  type AccountStateDto,
  type LinkStateDto,
  type PresenceDto,
  type TrustedPairDto,
} from '../lib/tauri';
import { useAppState } from '../lib/useAppState';
import { useLiveResource } from '../lib/useLiveResource';
import { STATUS_LABEL } from '../lib/status';
import { SoftwareUpdate } from './SoftwareUpdate';
import { AccountSignIn } from './AccountSignIn';
import { LinkStep } from './LinkStep';

const SCOPE_LABEL: Record<string, string> = {
  view: 'View',
  control: 'Control',
};

/**
 * What this device is actually asking for, as a sentence.
 *
 * The prompt used to read "wants to view and control this Mac" for every
 * request, whatever `requested_scopes` said, with the true scopes shown only as
 * chips underneath. On the highest-privilege action in the product, the
 * sentence a person reads before pressing Approve described a grant the request
 * had not asked for.
 *
 * An unrecognised scope falls back to the vaguer sentence rather than being
 * dropped: claiming less than is being asked for is the one failure this must
 * not have.
 */
function scopeSentence(scopes: readonly string[]): string {
  const view = scopes.includes('view');
  const control = scopes.includes('control');
  const known = scopes.every((scope) => scope === 'view' || scope === 'control');
  if (!known || scopes.length === 0) return 'wants to connect to this Mac';
  if (view && control) return 'wants to view and control this Mac';
  if (control) return 'wants to control this Mac';
  return 'wants to view this Mac’s screen';
}

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
  // Owned here, not inside the panels: it is what orders them.
  const [account, setAccount] = useState<AccountStateDto | null>(null);
  const link = useLiveResource<LinkStateDto>(() => api.getLinkState());
  const busySession = session === 'active' || session === 'connecting';
  // `unknown` passes: it means the backend could not be ASKED, not that this
  // machine is unowned, and `create_pairing` re-checks for real on click.
  const pairable =
    link.value === null || !['unlinked', 'revoked', 'no_identity'].includes(link.value.state);

  // Read once, then again only when `AccountPanel` reports the transition.
  //
  // This used to poll every 3s for as long as the dashboard was open on an
  // unlinked machine. Each poll is a challenge plus a signed token exchange,
  // and on an unlinked Mac the token half can only ever answer 403 — measured
  // in production on 2026-08-21 as 64 challenges and 61 rejected tokens in the
  // three minutes before linking, stopping the second it completed. Nothing was
  // learned by any of them: only `AccountPanel` can cause this transition, and
  // it already polls for exactly the window in which one is possible.
  const refreshLink = link.refresh;
  useEffect(refreshLink, [refreshLink]);

  return (
    <div className="page control dashboard">
      <header className="control__header">
        <h1>Lilypad</h1>
        <div className="control__header-actions">
          <span className={`badge badge--${session}`}>{STATUS_LABEL[session]}</span>
          {/* Mirrors the tray's `show_qr` rule exactly, and for the same two
           * reasons: not while a session is already underway, and not before
           * this computer is on an account — pairing an unowned machine writes
           * a trust relationship nobody can see or revoke (ADR-0010). */}
          <button
            className="btn btn--primary btn--icon"
            data-testid="pair-new-device"
            disabled={busySession || !pairable}
            title={
              busySession
                ? 'Disconnect the current session to pair a new device'
                : !pairable
                  ? 'Link this computer to your account first — pairing comes after'
                  : 'Pair a new device'
            }
            aria-label="Pair a new device"
            onClick={() => void api.showQrWindow()}
          >
            +
          </button>
        </div>
      </header>

      {/* The session changes without anyone touching this window — a phone
          rings, a link drops, a peer reconnects. Sighted users get that from
          this line changing under them; `polite` is what makes it reach
          everyone else, without interrupting whatever is being read. */}
      <p className="dashboard__subtitle muted" aria-live="polite" data-testid="session-summary">
        {sessionSummary(session, state?.shared_display ?? null)}
      </p>

      {/* Silent launch-time update check; renders only when an update exists. */}
      <SoftwareUpdate variant="banner" />

      {session === 'awaiting_approval' ? (
        // `alert`, not `status`: this is a request to control this Mac, it
        // arrives unprompted, and it expires. It is the one thing in the app
        // that has earned the right to interrupt.
        <section className="control__approve card" role="alert">
          <p className="control__approve-title">
            <strong>{pending?.device_name ?? 'An unknown device'}</strong>{' '}
            {scopeSentence(pending?.requested_scopes ?? [])}
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

      {/* Order is the product's own: who you are, then which computer is
          yours, then which phones may reach it. Signing in does not link
          (ADR-0010), so the two account panels are separate — and the second
          waits for the first, because offering a live enrollment QR to someone
          who has not said who they are puts the last step before the first. */}
      <AccountSignIn onChange={setAccount} />
      <LinkStep signedIn={account?.signedIn ?? false} onLinked={refreshLink} />
      <Reachability presence={state?.presence ?? null} linked={link.value?.state === 'linked'} />
      <TrustedDevices linked={link.value?.state === 'linked'} />
      <SystemPanel backendUrl={state?.backend_base_url ?? null} />
    </div>
  );
}

/**
 * Can a phone actually reach this Mac?
 *
 * A separate question from "is it linked", and the product could only answer
 * the second one. On 2026-08-22 this machine's presence register was refused
 * 56 times over six hours while its device row was owned and unrevoked: the
 * phone said "the laptop is offline", the Mac said "Linked", and nothing
 * anywhere said what was actually wrong or what to do about it.
 *
 * Silent while everything is fine. A reachability badge that is always on
 * screen becomes furniture, and the one state worth interrupting someone for
 * is the one where their phone cannot get through.
 */
function Reachability({ presence, linked }: { presence: PresenceDto | null; linked: boolean }) {
  // Nothing useful to say before the first attempt resolves, and nothing at
  // all to say about an unlinked machine — no phone is trying to reach it, and
  // `LinkStep` above is already asking for the step that matters.
  if (!presence || !linked) return null;
  if (presence.state === 'online' || presence.state === 'starting') return null;

  // `connecting` is a normal blip: the loop reconnects on wake, on a deploy,
  // and on any dropped socket. Saying so is honest; alarming about it is not.
  const transient = presence.state === 'connecting';

  const COPY: Record<string, { title: string; body: string }> = {
    connecting: {
      title: 'Reconnecting…',
      body: 'Your phone may not be able to reach this Mac for a moment.',
    },
    unreachable: {
      title: 'Your phone can’t reach this Mac',
      body: 'This Mac can’t reach Lilypad’s server. Check its internet connection — the phone will work again on its own once it’s back.',
    },
    refused: {
      title: 'Your phone can’t reach this Mac',
      body: 'Lilypad’s server won’t accept this Mac right now. If you removed it from your account, link it again above.',
    },
    no_identity: {
      title: 'Your phone can’t reach this Mac',
      body: 'This Mac can’t prove who it is — macOS may have denied Lilypad access to the keychain. Allow it and this will clear on its own.',
    },
  };
  const copy = COPY[presence.state];
  if (!copy) return null;

  return (
    <section className="control__reachability card" data-testid="reachability">
      <p className={transient ? 'muted' : 'error'}>
        <strong>{copy.title}</strong>
      </p>
      <p className="muted">{copy.body}</p>
    </section>
  );
}

/**
 * `sharedDisplay` is only ever set on a Mac with more than one screen, and it
 * belongs in this line rather than a badge somewhere: a phone can now move the
 * view to a different monitor, and the person sitting here should not have to
 * work out which screen somebody else is looking at. On a single-display Mac
 * there is nothing to disambiguate, so the sentence stays as it was.
 */
function sessionSummary(session: string, sharedDisplay: string | null): string {
  switch (session) {
    case 'active':
      return sharedDisplay
        ? `A device is connected and in control, showing ${sharedDisplay}.`
        : 'A device is connected and in control.';
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
/**
 * `linked` is not decoration. Under the account -> devices model a computer on
 * no account has no pairs to list, and `GET /devices/pairs` now answers 404 to
 * it rather than an empty array. `list_trusted_devices` turns any non-2xx into
 * an `Err`, which this rendered as "Couldn't load trusted devices - is the
 * backend running?" - false, and alarming, on a machine whose only problem is
 * that nobody has linked it yet.
 */
function TrustedDevices({ linked }: { linked: boolean }) {
  const {
    value: pairs,
    error,
    refresh,
  } = useLiveResource(() =>
    linked
      ? api.listTrustedDevices().then((p) => p.filter((pair) => !pair.revoked))
      : Promise.resolve([]),
  );
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Which pair's Revoke is in its "are you sure" second step. `window.confirm`
  // used to gate this, but it returns falsy in Tauri's wry webview — the
  // `if (!window.confirm(...)) return;` always bailed, so `revokePair` was
  // NEVER called (proven: the backend's revoke audit log never fired). An
  // inline two-step confirm works deterministically in any webview.
  const [confirmingRevokeId, setConfirmingRevokeId] = useState<string | null>(null);

  // Poll only while somebody is actually looking at this list.
  //
  // Every mutation below already refreshes on its own, so the timer exists
  // solely for changes made elsewhere — a phone pairing over the signaling
  // hub, or unpairing itself. Both only matter once the user looks back at
  // this window, so a hidden dashboard needs no polling at all: this is a tray
  // app, and background is where it spends most of its life. Measured in
  // production on 2026-08-21, the old unconditional 15s timer kept running
  // straight through two live sessions.
  //
  // `visibilitychange` is the platform's own answer to "is this being read?",
  // and refreshing on the way back in makes the list correct the moment it is
  // seen rather than up to fifteen seconds later.
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (id !== null) clearInterval(id);
      id = null;
    };
    const sync = () => {
      stop();
      if (document.visibilityState === 'hidden') return;
      refresh();
      id = setInterval(refresh, 15_000);
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', sync);
    };
    // `linked` belongs in here, not just in the fetcher. `refresh` is stable
    // by design, so without it the first render — where the link state has not
    // resolved yet and `linked` is still false — would fetch an empty list and
    // never look again once the answer arrived.
  }, [refresh, linked]);

  /**
   * What went wrong with the last thing the user pressed.
   *
   * Both actions below used to be `.then(refresh).catch(refresh)`, which
   * refreshes either way and says nothing either way. For the toggle that
   * means a checkbox that snaps back with no explanation — on the control that
   * decides whether a phone's session starts WITHOUT anyone clicking Approve.
   *
   * For Revoke it is worse. Someone presses it because a phone is lost or
   * because they want a device off their account, confirms a destructive
   * action, watches the row stay exactly where it was, and has no way to know
   * that the phone still has access. Silence there is not a missing message,
   * it is a false one.
   */
  const [actionError, setActionError] = useState<string | null>(null);

  const toggle = (pair: TrustedPairDto) => {
    setActionError(null);
    void api
      .setPairAutoApprove(pair.pairId, !pair.autoApprove)
      .then(refresh)
      .catch(() => {
        setActionError(
          'Couldn’t change that setting — Lilypad couldn’t be reached. It is unchanged.',
        );
        refresh();
      });
  };

  const revoke = (pair: TrustedPairDto) => {
    setConfirmingRevokeId(null);
    setActionError(null);
    void api
      .revokePair(pair.pairId)
      .then(refresh)
      .catch(() => {
        setActionError(
          `Couldn’t remove ${pair.displayName ?? 'that phone'} — Lilypad couldn’t be reached, and it still has access. Try again.`,
        );
        refresh();
      });
  };

  return (
    <section className="control__devices card">
      <h2 className="section-title">Trusted devices</h2>
      {!linked ? (
        <p className="muted" data-testid="trusted-devices-unlinked">
          This computer isn’t on an account yet, so it has no trusted phones. Link it above first.
        </p>
      ) : null}
      {/* "is the backend running?" was the previous copy — a question a
          customer has no way to answer, about a word they have never seen. The
          list is a cache of something a server knows, so the honest thing to
          say is that it might be stale, and to offer the one action that helps. */}
      {linked && error ? (
        <div data-testid="trusted-devices-error">
          <p className="muted">Couldn’t reach Lilypad just now, so this list may be out of date.</p>
          <div className="row">
            <button className="btn btn--small" data-testid="retry-trusted" onClick={refresh}>
              Try again
            </button>
          </div>
        </div>
      ) : null}
      {actionError ? (
        <p className="error" role="alert" data-testid="trusted-devices-action-error">
          {actionError}
        </p>
      ) : null}
      {linked && pairs !== null && pairs.length === 0 ? (
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
                  <input
                    type="checkbox"
                    data-testid="auto-approve"
                    checked={pair.autoApprove}
                    onChange={() => toggle(pair)}
                  />
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
