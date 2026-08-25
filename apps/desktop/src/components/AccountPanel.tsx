import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { api, type EnrollmentQrDto, type LinkStateDto } from '../lib/tauri';
import { useLiveResource } from '../lib/useLiveResource';

/**
 * Whether this computer is on the account, and what to do when it is not.
 *
 * **This is a status card, not a step.** Signing in is what puts a Mac on an
 * account ([ADR-0015](../../../../docs/adr/0015-ownership-follows-sign-in.md)),
 * so by the time anyone reads this the answer is normally already yes and the
 * card is one line long. It used to be the ceremony itself — a QR the customer
 * had to scan before the machine was theirs — which is the step ADR-0015
 * removed.
 *
 * The QR did not go away, it stopped being the front door. It is the recovery
 * path for the two states sign-in cannot fix by itself: a Mac whose enrollment
 * failed (already on another account, offline at the wrong moment), and a Mac
 * whose access was revoked. A signed-in phone scanning it adopts the machine
 * onto that phone's account — the WhatsApp Web / Steam model
 * ([ADR-0008](../../../../docs/adr/0008-desktop-enrollment-via-phone.md)).
 */

/** How often to re-ask while a code is on screen. Each poll is a challenge
 * plus a token exchange against endpoints budgeted at 60/minute, so 3s (20 per
 * minute) leaves ample headroom while still feeling immediate. */
const POLL_MS = 3_000;

export interface AccountPanelProps {
  /**
   * Fired once this computer becomes linked.
   *
   * This panel is the ONLY thing that can cause that transition — see the
   * comment on the poll below — so screens that need to re-read the link state
   * are told by it rather than each running a poll of their own.
   */
  onLinked?: () => void;
}

export function AccountPanel({ onLinked }: AccountPanelProps = {}) {
  const { value: link, refresh } = useLiveResource<LinkStateDto>(() => api.getLinkState());
  const [enrollment, setEnrollment] = useState<EnrollmentQrDto | null>(null);
  const [dataUrl, setDataUrl] = useState('');
  const [error, setError] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  useEffect(refresh, [refresh]);

  const linked = link?.state === 'linked';

  // Poll only while a code is showing. Approval happens on the PHONE, so
  // there is nothing local to react to — but polling a machine nobody is
  // trying to adopt would be a request every 3s, forever, for no reason.
  //
  // The other transition — a sign-in enrolling this Mac (ADR-0015) — needs no
  // poll at all: it completes inside the sign-in call, and the screens hosting
  // this card re-read the state when `AccountSignIn` reports success.
  //
  // `expired` is part of the guard, not just the badge. The code dies
  // server-side after `DESKTOP_ENROLLMENT_TTL_SECONDS` (120s), but
  // `enrollment` is only cleared on SUCCESS — so a user who opened this step,
  // did not scan, and walked away left the poll running every 3s forever,
  // against a code the backend had already forgotten. Nothing it asked could
  // ever change.
  const expired = enrollment !== null && secondsLeft <= 0;
  useEffect(() => {
    if (!enrollment || linked || expired) return;
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [enrollment, linked, expired, refresh]);

  // The code stops being useful the moment the phone approves.
  useEffect(() => {
    if (linked) {
      setEnrollment(null);
      setDataUrl('');
      // Tell whoever is hosting this panel, so they can re-read instead of
      // polling for a transition only this component can cause. The re-read is
      // free: the Rust side has cached the identity by now, so `get_link_state`
      // answers without touching the network.
      onLinked?.();
    }
  }, [linked, onLinked]);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const id = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [secondsLeft]);

  const startLinking = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const minted = await api.startEnrollment();
      setEnrollment(minted);
      setSecondsLeft(minted.expiresInSeconds);
      // Exactly the shape `DesktopEnrollmentQrSchema` validates on the phone.
      const url = await QRCode.toDataURL(
        JSON.stringify({
          v: 1,
          kind: 'desktop-enrollment',
          code: minted.code,
          apiBaseUrl: minted.apiBaseUrl,
          deviceName: minted.deviceName,
          platform: minted.platform,
        }),
        { margin: 1, width: 200, color: { dark: '#0b3d2e', light: '#ffffff' } },
      );
      setDataUrl(url);
    } catch (err) {
      setError(String(err));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, []);

  return (
    <section className="control__account card" data-testid="account-panel">
      <h2 className="section-title">This computer</h2>

      {link === null ? (
        <p className="muted">Checking…</p>
      ) : link.state === 'linked' ? (
        <p className="muted" data-testid="link-state-linked">
          <strong>On your account</strong> — you can see and remove this computer from your phone.
        </p>
      ) : link.state === 'no_identity' ? (
        // A dead end until 2026-08-22, and reachable by accident: this is what
        // a dismissed or not-yet-unlocked login keychain looks like. (The
        // access prompt used to return on every update, when the app was
        // ad-hoc signed and its code requirement changed with each build;
        // since v0.1.7's Developer ID signature it does not, which makes this
        // rarer but no less reachable.) The failure is no longer remembered for the life of the
        // process (`DesktopAuth::device_auth`), so a second attempt can
        // genuinely succeed — but only if something asks for one, and nothing
        // on this screen did.
        <div data-testid="link-state-no-identity">
          <p className="error">
            Lilypad couldn’t save this computer’s key to the macOS keychain, so it can’t join your
            account yet. If a keychain permission box appeared, allow it and try again.
          </p>
          <div className="row">
            <button className="btn" data-testid="retry-identity" onClick={refresh}>
              Try again
            </button>
          </div>
        </div>
      ) : link.state === 'unknown' ? (
        // NOT "not on your account": we do not know, and saying the wrong one
        // sends someone to redo a step they already completed.
        <p className="muted" data-testid="link-state-unknown">
          Can’t reach Lilypad’s server, so the account status is unknown right now.
        </p>
      ) : (
        // Signing in should have handled this, so reaching it means something
        // went wrong that the customer cannot see — most often a Mac that is
        // already on somebody else's account. Say what is true and offer the
        // one thing that still works.
        <p className="muted" data-testid="link-state-unlinked">
          <strong>Not on your account</strong> —{' '}
          {link.state === 'revoked'
            ? 'this computer was removed from the account. Add it again below to restore it.'
            : 'signing in should have added this computer. It didn’t, so it can’t pair a phone yet — add it from your phone below.'}
        </p>
      )}

      {!linked && link?.state !== 'no_identity' ? (
        <>
          {enrollment ? (
            <div className="account__enroll">
              <p className="muted">
                On your phone: open Lilypad, sign in, then scan this code to add this computer to
                that phone’s account.
              </p>
              <div className={`qr__frame ${expired ? 'qr__frame--expired' : ''}`}>
                {dataUrl ? (
                  <img
                    src={dataUrl}
                    alt="Add this computer to your account"
                    width={200}
                    height={200}
                  />
                ) : null}
                {expired ? <div className="qr__expired-badge">Expired</div> : null}
              </div>
              <p className="muted">
                {expired ? 'This code has expired.' : `Expires in ${secondsLeft}s`}
              </p>
            </div>
          ) : null}

          <div className="row">
            <button
              className="btn btn--primary"
              disabled={busy}
              onClick={() => void startLinking()}
            >
              {enrollment ? 'New code' : 'Add this computer from my phone'}
            </button>
          </div>
        </>
      ) : null}

      {error ? <p className="error">{error}</p> : null}
    </section>
  );
}
