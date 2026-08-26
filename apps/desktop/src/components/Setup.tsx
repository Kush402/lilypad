import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { AgentProviderCard } from './AgentProviderCard';
import { IconCheck } from './Icon';
import { AccountSignIn } from './AccountSignIn';
import { LinkStep } from './LinkStep';
import { api, type AccountStateDto, type LinkStateDto } from '../lib/tauri';
import { useLiveResource } from '../lib/useLiveResource';
import { useAppState } from '../lib/useAppState';

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
 * binds a TCC grant to the *code signature* of the app that asked for it. TCC
 * keeps showing the switch as on — it is on, for the version that asked —
 * while denying the running binary, whose signature no longer matches.
 * Confirmed on this Mac: the recorded requirement named two cdhashes, and the
 * installed app's was neither.
 *
 * Re-adding the app in System Settings rewrites the requirement against the
 * installed binary, which is the only user-side repair.
 *
 * Since v0.1.7 Lilypad ships with a Developer ID signature and an Apple
 * notarization, which is exactly the stable identity TCC needs — so a grant
 * now survives an update, and this is no longer the permanent condition the
 * copy used to describe. It still happens ONCE on a Mac that granted an
 * earlier, ad-hoc-signed build: that grant is bound to a cdhash no signed
 * build will ever have again. The copy below says that, rather than the old
 * "Lilypad is not signed yet", which stopped being true two releases ago.
 */
const RESTART_TRIED_KEY = 'lilypad.permission.restart-tried';

/**
 * First run, end to end: **your account → permissions → pair your phone**, in
 * that order, in one window.
 *
 * **It used to be four steps, and one of them was not a step.** Between the
 * permissions and pairing sat "3 · Link this computer": show a QR, pick up the
 * phone, scan, put the phone down, then show a SECOND QR and scan again. Both
 * scans were real ceremonies with real backend routes, and to the person doing
 * them they were the same act performed twice.
 *
 * [ADR-0015](../../../../docs/adr/0015-ownership-follows-sign-in.md) removed
 * the first one: signing in is what puts this Mac on the account, exactly as
 * signing in on a phone always did. What is left is the step that was doing
 * real work all along — pairing a phone to this computer — and it is now the
 * only time anyone picks up a phone.
 *
 * **Pairing still requires ownership, and the words here have to say so.**
 * `/pairing/create` resolves the desktop's ownership and refuses a computer
 * that belongs to no account — `actAsDevice`'s only `allow` is `owner`, since
 * the unowned lane closed. That state should now be unreachable after a
 * successful sign-in, but "should" is not "is", so step 3 still checks rather
 * than assuming.
 *
 * Sign-in used to have no step here at all, because the desktop had no way to
 * perform one: [ADR-0008](../../../../docs/adr/0008-desktop-enrollment-via-phone.md)
 * gives it no OAuth client, and magic link needs a mail sender production does
 * not have. [ADR-0012](../../../../docs/adr/0012-password-authentication.md)
 * adds email + password, which needs neither — so step 1 exists, and ADR-0015
 * is what makes it carry the weight the removed step used to.
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
  /**
   * Whether this window is the first-run WIZARD or the SETTINGS window.
   *
   * **Both, and it has to be — but never both at once.** Setup was written as a
   * wizard and stayed one forever: a customer who had finished it and came back
   * to change their Ask AI key was met with "Set up Lilypad · Three steps",
   * numbered steps they had already done, and a "Done" button, for a window
   * they had opened to edit one field. The one-time part of setup genuinely is
   * one-time; the configurable part is not, and the same window has to be able
   * to say which it is being.
   *
   * **Decided once, from its own read, then never revisited.** Not derived from
   * the live state below, for two reasons. It would start as `wizard` on every
   * mount — the defaults describe a Mac with no account and no permissions,
   * which is the one answer a returning customer must never be given, even for
   * a frame. And it would flip to `settings` under a first-run user at the
   * exact moment they granted the last permission, renaming the window and
   * renumbering the steps mid-flow.
   *
   * `null` renders nothing: two local IPC calls, not a network round trip.
   */
  const [mode, setMode] = useState<'wizard' | 'settings' | null>(null);
  useEffect(() => {
    let alive = true;
    void Promise.all([
      invoke<PermissionStatusDto>('get_permission_status').catch(() => null),
      // `invoke` rather than `api.getAccountState`, matching the permission
      // read beside it: one Tauri seam for this window, not two.
      invoke<AccountStateDto>('get_account_state').catch(() => null),
    ]).then(([permissions, account]) => {
      if (!alive) return;
      const done =
        permissions?.screen_capture === true &&
        permissions?.accessibility === true &&
        account?.signedIn === true;
      setMode(done ? 'settings' : 'wizard');
    });
    return () => {
      alive = false;
    };
  }, []);
  // The title bar is the one part of this window Rust names, and it names it
  // once, at creation. A window that has become Settings must not keep saying
  // Setup in the place macOS puts it in the Window menu and in Mission Control.
  //
  // Each title is the window's own heading, verbatim. They used to be
  // "Lilypad — Setup": macOS already puts the app's name in the menu bar, so
  // that repeated a word the customer did not need behind a dash they did not
  // need either.
  useEffect(() => {
    if (mode === null) return;
    try {
      void getCurrentWindow().setTitle(mode === 'wizard' ? 'Set up Lilypad' : 'Lilypad Settings');
    } catch {
      /* not running inside Tauri */
    }
  }, [mode]);

  // Minting a pairing code ends whatever session is running — see
  // `create_pairing`. The dashboard's "+" has always known that; this window
  // did not, so one click here disconnected a phone mid-session.
  const appState = useAppState();
  const session = appState?.session ?? 'idle';
  const busySession = session === 'active' || session === 'connecting';

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

  /**
   * Sign-in is the moment this Mac joins the account, so the ownership card
   * below is stale the instant this fires — and nothing else will tell it. The
   * old flow had a QR ceremony to poll; this one completes inside the sign-in
   * call ([ADR-0015](../../../../docs/adr/0015-ownership-follows-sign-in.md)).
   *
   * **`useCallback` is load-bearing, not tidiness.** `AccountSignIn` builds its
   * `apply` from `onChange` and runs its mount effect on `[apply]`, so an inline
   * arrow here is a new identity every render: effect → `onChange` →
   * `refreshLink` → state → render → new arrow → effect. That is an infinite
   * loop, and it presents as a test that never finishes rather than as an error.
   */
  const onAccountChange = useCallback(
    (next: AccountStateDto) => {
      setAccount(next);
      refreshLink();
    },
    [refreshLink],
  );

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

  if (mode === null) return null;
  const wizard = mode === 'wizard';

  return (
    <div className="page setup" data-testid={wizard ? 'setup-wizard' : 'setup-settings'}>
      <h1>{wizard ? 'Set up Lilypad' : 'Lilypad Settings'}</h1>
      <p className="muted">
        {wizard
          ? 'Three steps. Only the last one needs your phone.'
          : 'Everything about this Mac. Nothing here is a step, so change what you like and close the window.'}
      </p>

      {/* Step 1 is now load-bearing rather than merely first: signing in is
          what puts this Mac on the account (ADR-0015), so everything below
          genuinely depends on it. Same component as the dashboard's: one
          sign-in form, two places it is reachable. */}
      <h2 className="section-title">{wizard ? '1 · Your account' : 'Your account'}</h2>
      {/* `signup` only in the wizard. A returning customer opening Settings has
          an account by definition, and opening on a Create-account form would
          invite them to make a second one. */}
      <AccountSignIn onChange={onAccountChange} initialMode={wizard ? 'signup' : 'signin'} />
      <LinkStep signedIn={signedIn} onLinked={refreshLink} />

      <h2 className="section-title">{wizard ? '2 · Permissions' : 'Permissions'}</h2>
      {!signedIn ? (
        /* Asking for Screen Recording before the user has an account inverts
           the product: macOS permissions are the most alarming thing Lilypad
           ever requests, and a stranger who has not yet said who they are has
           been given no reason to say yes. Locked rather than hidden, so the
           flow still reads as four steps rather than appearing to end here. */
        <p className="muted" data-testid="permissions-step-locked">
          {wizard ? 'Finish step 1 first.' : 'Sign in above first.'} Lilypad asks for Screen
          Recording and Accessibility only once this Mac is on an account.
        </p>
      ) : (
        <>
          <p className="muted">Two are needed before this Mac can be controlled at all.</p>

          {needsRestart && restartAlreadyTried ? (
            <section className="control__approve" data-testid="permission-stale-tcc">
              <p>
                <strong>macOS is still refusing</strong>, and restarting did not help, so the switch
                being on in System Settings is not the whole story.
              </p>
              <p className="muted">
                macOS ties a permission to the exact app that asked for it. If this Mac granted
                Lilypad access before the app was signed by Apple, that old grant no longer matches:
                the switch stays on while the current version is refused. To repair it, open
                Settings, select Lilypad in the list, remove it with the “−” button, then add
                Lilypad back. Signed builds keep their permissions across updates, so this is a
                one-time repair.
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
                <strong>Finish setup.</strong> Lilypad needs to restart once to pick up the new
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
                {/* This flips while the user is over in System Settings, with
                    no interaction here to hang an announcement on — the whole
                    point of the live poll above. Sighted users see the chip
                    appear; `polite` is how everyone else learns the step is
                    done and they can come back. */}
                <p className="control__approve-title" aria-live="polite">
                  <strong>{COPY[kind].label}</strong>
                  {granted ? (
                    <span className="chip" data-testid={`granted-${kind}`}>
                      Granted
                    </span>
                  ) : null}
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

      {/* Step 3 only once the Mac can actually do anything — offering to pair a
          computer that cannot capture or type is a step out of order. Same rule
          in Settings, where it means something slightly different: a permission
          revoked since setup makes pairing pointless in exactly the same way,
          and the section above is already saying so. */}
      {allGranted ? (
        <>
          <h2 className="section-title">{wizard ? '3 · Pair your phone' : 'Paired phones'}</h2>
          {linked ? (
            <>
              <p className="muted">
                Show the pairing code and scan it with Lilypad on your phone. Pair once. After that
                the phone reconnects on its own, and this Mac appears in its list.
              </p>
              <section className="control__approve">
                <div className="row">
                  {/* Disabled, not merely refused. `create_pairing` now says no
                      as well, and that is the guarantee — but a button that
                      looks live and answers with a refusal is a worse screen
                      than one that says why before you press it. Mirrors the
                      dashboard's "+" exactly, including the sentence. */}
                  <button
                    className="btn btn--primary"
                    data-testid="show-pairing-code"
                    disabled={busySession}
                    title={
                      busySession
                        ? 'Disconnect the current session to pair a new device'
                        : 'Show the pairing code'
                    }
                    onClick={() => void api.showQrWindow()}
                  >
                    Show pairing code
                  </button>
                </div>
                {busySession ? (
                  <p className="muted" data-testid="pairing-blocked-by-session">
                    A phone is connected right now. Pairing another would end that session, so
                    disconnect it from the Lilypad dashboard first.
                  </p>
                ) : null}
              </section>
            </>
          ) : (
            /* Pairing an unowned computer writes a trust relationship that
               belongs to no account: it cannot appear in anyone's "Your
               devices" and nobody can revoke it. `/pairing/create` refuses it
               outright, so saying so beats a button that answers 404. */
            <p className="muted" data-testid="pair-step-locked">
              This Mac isn’t on your account yet, so it can’t pair a phone.{' '}
              {wizard ? 'Step 1' : 'Signing in above'} is what puts it there, and the card under it
              says what went wrong.
            </p>
          )}
        </>
      ) : null}

      {wizard && allGranted ? (
        <section className="control__active" data-testid="setup-done">
          {/* Three states, not two. "Not on an account" and "we could not ask"
              are different facts, and `LinkStateDto` separates them on purpose:
              telling a linked user to redo the linking ceremony because their
              wifi dropped is worse than admitting we do not know. */}
          {linked ? (
            <p data-testid="setup-done-linked">
              <IconCheck /> This computer is set up and belongs to your account.
            </p>
          ) : linkUnknown ? (
            <p data-testid="setup-done-unknown">
              Permissions are done. We could not check whether this computer is on an account. If it
              already is, it stays that way and pairing will work.
            </p>
          ) : (
            <p data-testid="setup-done-unlinked">
              Permissions are done, but this computer is not on an account yet, so it can’t pair a
              phone. The card under step 1 says what to do.
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
          something, and never blocks anything.

          **In Settings it is never gated.** It is the single most likely reason
          anyone opens this window a second time — an API key is a thing that
          expires, gets rotated, and gets typed wrong — and gating it behind a
          macOS permission it has nothing to do with is how it became
          unreachable in the first place. */}
      {wizard && !allGranted ? null : (
        <div data-testid="ask-optional">
          <h2 className="section-title">{wizard ? 'Optional · Ask' : 'Ask AI'}</h2>
          <AgentProviderCard />
        </div>
      )}

      {/* No "Done" in Settings — there is nothing to be done with. A window you
          opened to change one field closes because you are finished with it,
          which is what the traffic light already means. This is the same act
          spelled out, for the same reason the wizard's Done button exists: the
          window is 720px tall and the close button is at the top of it. */}
      {wizard ? null : (
        <div className="row">
          <button className="btn" onClick={() => void getCurrentWindow().close()}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}
