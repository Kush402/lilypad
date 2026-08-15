import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { AgentProviderCard } from './AgentProviderCard';
import { AccountSignIn } from './AccountSignIn';
import { LinkStep } from './LinkStep';
import { api, type AccountStateDto, type LinkStateDto } from '../lib/tauri';
import { useLiveResource } from '../lib/useLiveResource';

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

/** How often to re-ask whether a phone has adopted this computer. Matches
 * `AccountPanel`'s cadence, against endpoints budgeted at 60/minute. */
const LINK_POLL_MS = 3_000;

/**
 * First run, end to end: **your account → permissions → link this computer →
 * pair a phone**, in that order, in one window.
 *
 * It used to stop after the permissions and say "All set — you can start
 * pairing now", which was the one thing P1's definition of done forbids: the
 * desktop announcing it is ready before a phone has approved it. Permissions
 * let the machine capture and type; they say nothing about whose machine it is.
 *
 * **Linking is offered, not demanded.** Pairing genuinely works on an unlinked
 * computer, so a wizard that blocked on linking would be lying in the other
 * direction. Step 3 is therefore skippable and the final card tells the truth
 * either way — set up and owned, or set up and on no account yet
 * ([ADR-0010](../../../../docs/adr/0010-explicit-device-linking.md)).
 *
 * Sign-in used to have no step here at all, because the desktop had no way to
 * perform one: [ADR-0008](../../../../docs/adr/0008-desktop-enrollment-via-phone.md)
 * gives it no OAuth client, and magic link needs a mail sender production does
 * not have. [ADR-0012](../../../../docs/adr/0012-password-authentication.md)
 * adds email + password, which needs neither — so step 1 exists now.
 *
 * It is still true that the LINKING half happens on the phone: the QR in step 3
 * tells the phone which backend to sign in to, and that phone's approval is
 * what adopts this machine. Signing in here changes nothing about that.
 *
 * The permission half is unchanged from the original wizard. Previously the
 * ONLY signal a permission problem existed was a passive TCC preflight
 * surfacing as a raw "degraded: ..." string buried in a debug list — no active
 * request, no remediation path, no way to know a relaunch might be needed. It:
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
  const [account, setAccount] = useState<AccountStateDto | null>(null);
  const [restarting, setRestarting] = useState(false);
  // Read here as well as inside AccountPanel: the final card has to say which
  // of two true things is true, and it cannot ask the panel.
  const { value: linkState, refresh: refreshLink } = useLiveResource<LinkStateDto>(() =>
    api.getLinkState(),
  );
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

  const allGranted = status.screen_capture && status.accessibility;
  const linked = linkState?.state === 'linked';
  // `unknown` means the backend could not be asked; a null value means the
  // first read has not landed yet. Neither is evidence that nobody owns this
  // machine, so neither may be reported as such.
  const linkUnknown = linkState === null || linkState.state === 'unknown';

  // Approval happens on the phone, so there is nothing local to react to. Poll
  // only while the answer can still change: once linked, the final card is
  // already saying the right thing and there is nothing left to learn.
  useEffect(() => {
    refreshLink();
    if (!allGranted || linked) return;
    const id = setInterval(refreshLink, LINK_POLL_MS);
    return () => clearInterval(id);
  }, [refreshLink, allGranted, linked]);

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

  return (
    <div className="page setup">
      <h1>Set up Lilypad</h1>
      <p className="muted">Four steps, and the last two take a phone.</p>

      {/* Step 1 because it is step 1 of the product, not because anything
          below needs it. Linking is approved by a signed-in PHONE, so this Mac
          can complete every remaining step signed out — but a first run that
          never mentions an account, and ends at a QR code, teaches the wrong
          model of what Lilypad is. Same component as the dashboard's: one
          sign-in form, two places it is reachable. */}
      <h2 className="section-title">1 · Your account</h2>
      <AccountSignIn onChange={setAccount} />

      <h2 className="section-title">2 · Permissions</h2>
      <p className="muted">Two are needed before this Mac can be controlled at all.</p>

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

      {/* Steps 3 and 4 only once the Mac can actually do anything — offering to
          put an unusable computer on an account is a step out of order. */}
      {allGranted ? (
        <>
          <h2 className="section-title">3 · Link this computer</h2>
          <p className="muted">
            Optional, and worth doing: linking is what puts this Mac on your account, so you can see
            and remove it from your phone. Pairing works without it.
          </p>
          <LinkStep signedIn={account?.signedIn ?? false} />

          <h2 className="section-title">4 · Pair a phone</h2>
          <p className="muted">
            Show the pairing code and scan it with Lilypad on your phone. Pair once — after that the
            phone reconnects on its own.
          </p>
          <section className="control__approve">
            <div className="row">
              <button className="btn btn--primary" onClick={() => void api.showQrWindow()}>
                Show pairing code
              </button>
            </div>
          </section>
        </>
      ) : null}

      {/* Unnumbered on purpose: Ask is a feature you can set up whenever, not a
          step between you and a working session. */}
      <h2 className="section-title">Optional · Ask</h2>
      <AgentProviderCard />

      {allGranted ? (
        <section className="control__active" data-testid="setup-done">
          {/* Three states, not two. "Not on an account" and "we could not ask"
              are different facts, and `LinkStateDto` separates them on purpose:
              telling a linked user to redo the linking ceremony because their
              wifi dropped is worse than admitting we do not know. */}
          {linked ? (
            <p data-testid="setup-done-linked">
              ✓ This computer is set up and belongs to your account.
            </p>
          ) : linkUnknown ? (
            <p data-testid="setup-done-unknown">
              ✓ Permissions are done, so you can pair a phone. We could not check whether this
              computer is on an account — if you have already linked it, it stays linked.
            </p>
          ) : (
            <p data-testid="setup-done-unlinked">
              ✓ Permissions are done, so you can pair a phone. This computer is not on an account
              yet — step 3 is what changes that.
            </p>
          )}
          <div className="row">
            <button className="btn btn--primary" onClick={() => void getCurrentWindow().close()}>
              Done
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
