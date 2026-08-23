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

/**
 * Survives the relaunch `restart_app` performs, so "we already tried that" is
 * knowable after the process it happened in is gone.
 *
 * A restart that does not fix the permission means the problem is not the
 * one a restart fixes. The remaining cause is verified and specific: macOS
 * binds a TCC grant to the *code signature* of the app that asked for it, and
 * Lilypad is ad-hoc signed, so every build has a different cdhash. TCC keeps
 * showing the switch as on — it is on, for the version that asked — while
 * denying the running binary, whose hash no longer matches. Confirmed on this
 * Mac: the recorded requirement named two cdhashes, and the installed app's
 * was neither.
 *
 * Re-adding the app in System Settings rewrites the requirement against the
 * installed binary, which is the only user-side repair. The real fix is a
 * Developer ID signature, which gives TCC a stable identity that survives
 * updates; until Lilypad has one, this will recur on every single update, and
 * the copy below says so rather than looping the user through a button that
 * cannot work.
 */
const RESTART_TRIED_KEY = 'lilypad.permission.restart-tried';

/**
 * First run, end to end: **your account → permissions → link this computer →
 * pair a phone**, in that order, in one window.
 *
 * It used to stop after the permissions and say "All set — you can start
 * pairing now", which was the one thing P1's definition of done forbids: the
 * desktop announcing it is ready before a phone has approved it. Permissions
 * let the machine capture and type; they say nothing about whose machine it is.
 *
 * **Linking is required, and the words here have to say so.** They did not.
 * `/pairing/create` resolves the desktop's ownership and refuses a computer
 * that belongs to no account — `actAsDevice`'s only `allow` is `owner`, since
 * the unowned lane closed. An unlinked Mac holds no device token at all
 * (`/devices/enroll` answers 403 `desktop_enrollment_requires_approval` to a
 * desktop trying to link itself), so it is refused before it can ask. Verified
 * against a running backend: `POST /pairing/create` with no token answers
 * `404 not_found`.
 *
 * Step 4 already waited for step 3. The closing card did not, and told an
 * unlinked user "you can pair a phone" four lines below the panel explaining
 * that they could not
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
  const [restartAlreadyTried] = useState(() => {
    try {
      return localStorage.getItem(RESTART_TRIED_KEY) === '1';
    } catch {
      return false;
    }
  });
  // Steps 2-4 hang off this. `account` is null until the first read lands, and
  // "not read yet" is not "signed out" — but the only cost of being cautious
  // here is a step staying locked for one tick, where the cost of being wrong
  // the other way is prompting a stranger for Screen Recording.
  const signedIn = account?.signedIn ?? false;
  const linked = linkState?.state === 'linked';
  // `unknown` means the backend could not be asked; a null value means the
  // first read has not landed yet. Neither is evidence that nobody owns this
  // machine, so neither may be reported as such.
  const linkUnknown = linkState === null || linkState.state === 'unknown';

  // Approval happens on the phone, so there is nothing local to react to. Poll
  // only while the answer can still change: once linked, the final card is
  // already saying the right thing and there is nothing left to learn.
  // Once the permissions are actually satisfied the stuck-state marker has
  // done its job; leaving it set would make the next unrelated stall skip
  // straight to the re-add advice without trying the restart that usually
  // works.
  useEffect(() => {
    if (!allGranted) return;
    try {
      localStorage.removeItem(RESTART_TRIED_KEY);
    } catch {
      /* nothing to clean up if storage is unavailable */
    }
  }, [allGranted]);

  // Read once, then again only when `AccountPanel` reports the transition —
  // see the same change in `Control.tsx`. This used to poll for the whole
  // stretch between granting the permissions and linking, which on a first run
  // is however long the user takes to pick up their phone, at two rejected
  // round-trips every three seconds.
  useEffect(refreshLink, [refreshLink]);

  const grant = async (kind: PermissionKind) => {
    const granted = await invoke<boolean>('request_permission', { kind });
    setStatus((prev) => ({ ...prev, [kind]: granted }));
  };

  const openSettings = async (kind: PermissionKind) => {
    openedSettingsFor.current[kind] = true;
    await invoke('open_permission_settings', { kind });
  };

  const restart = async () => {
    // Remembered across the relaunch so a restart that does not help is not
    // offered a second time — see `RESTART_TRIED_KEY`.
    try {
      localStorage.setItem(RESTART_TRIED_KEY, '1');
    } catch {
      /* private mode / storage disabled — the worst case is re-offering. */
    }
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
      <AccountSignIn onChange={setAccount} initialMode="signup" />

      <h2 className="section-title">2 · Permissions</h2>
      {!signedIn ? (
        /* Asking for Screen Recording before the user has an account inverts
           the product: macOS permissions are the most alarming thing Lilypad
           ever requests, and a stranger who has not yet said who they are has
           been given no reason to say yes. Locked rather than hidden, so the
           flow still reads as four steps rather than appearing to end here. */
        <p className="muted" data-testid="permissions-step-locked">
          Finish step 1 first. Lilypad asks for Screen Recording and Accessibility only once there
          is an account to attach this Mac to.
        </p>
      ) : (
        <>
          <p className="muted">Two are needed before this Mac can be controlled at all.</p>

          {needsRestart && restartAlreadyTried ? (
            <section className="control__approve" data-testid="permission-stale-tcc">
              <p>
                <strong>macOS is still refusing</strong> — and restarting did not help, so the
                switch being on in System Settings is not the whole story.
              </p>
              <p className="muted">
                macOS ties a permission to the exact version of the app that asked for it. Lilypad
                is not signed yet, so this update looks like a different app to macOS: the switch
                stays on for the old version while the new one is refused. To repair it, open
                Settings, select Lilypad in the list, remove it with the “−” button, then add
                Lilypad back. Until Lilypad is signed, this can recur after an update.
              </p>
              <div className="row">
                {KINDS.filter((kind) => !status[kind]).map((kind) => (
                  <button key={kind} className="btn" onClick={() => void openSettings(kind)}>
                    Open {COPY[kind].label}
                  </button>
                ))}
              </div>
            </section>
          ) : needsRestart ? (
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
        </>
      )}

      {/* Steps 3 and 4 only once the Mac can actually do anything — offering to
          put an unusable computer on an account is a step out of order. */}
      {allGranted ? (
        <>
          <h2 className="section-title">3 · Link this computer</h2>
          <p className="muted">
            Linking is what puts this Mac on your account, so you can see it — and remove it — from
            your phone. Pairing comes after it.
          </p>
          <LinkStep signedIn={signedIn} onLinked={refreshLink} />

          <h2 className="section-title">4 · Pair a phone</h2>
          {linked ? (
            <>
              <p className="muted">
                Show the pairing code and scan it with Lilypad on your phone. Pair once — after that
                the phone reconnects on its own.
              </p>
              <section className="control__approve">
                <div className="row">
                  <button className="btn btn--primary" onClick={() => void api.showQrWindow()}>
                    Show pairing code
                  </button>
                </div>
              </section>
            </>
          ) : (
            /* Pairing an unowned computer writes a trust relationship that
               belongs to no account: it cannot appear in anyone's "Your
               devices" and nobody can revoke it. ADR-0010 rejected that state,
               so this waits for step 3 rather than producing one. */
            <p className="muted" data-testid="pair-step-locked">
              Finish step 3 first. A phone paired with a computer that is on no account can’t be
              managed or removed from anywhere, so pairing waits until this Mac is yours.
            </p>
          )}
        </>
      ) : null}

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
              Permissions are done. We could not check whether this computer is on an account — if
              you have already linked it, it stays linked, and pairing will work. If you have not,
              step 3 comes first.
            </p>
          ) : (
            <p data-testid="setup-done-unlinked">
              Permissions are done, but this computer is not on an account yet, so it can’t pair a
              phone. Step 3 is what changes that.
            </p>
          )}
          <div className="row">
            <button className="btn btn--primary" onClick={() => void getCurrentWindow().close()}>
              Done
            </button>
          </div>
        </section>
      ) : null}

      {/* Unnumbered on purpose: Ask is a feature you can set up whenever, not a
          step between you and a working session. It sits after the closing card
          rather than before step 1, which is where it used to be — a first run
          that opens by asking a stranger to paste an AI provider's API key,
          before they have an account or a working Mac, reads as a product that
          does not know what it is for. It appears once this Mac can actually do
          something, and never blocks anything. */}
      {allGranted ? (
        <div data-testid="ask-optional">
          <h2 className="section-title">Optional · Ask</h2>
          <AgentProviderCard />
        </div>
      ) : null}
    </div>
  );
}
