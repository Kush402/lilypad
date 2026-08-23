import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { api, type EnrollmentQrDto, type LinkStateDto } from '../lib/tauri';
import { useLiveResource } from '../lib/useLiveResource';

/**
 * This computer's account, on the dashboard (P1).
 *
 * The product rule this panel exists to make visible
 * ([ADR-0010](../../../../docs/adr/0010-explicit-device-linking.md)): **an
 * account never discovers devices.** Signing in tells Lilypad who you are;
 * linking tells it which computer is yours. So this panel says **Not linked**
 * until a phone has actually approved this machine, and never implies
 * availability before that.
 *
 * The desktop has no OAuth client of its own
 * ([ADR-0008](../../../../docs/adr/0008-desktop-enrollment-via-phone.md)): it
 * shows a QR, a signed-in phone scans it, and that phone's account adopts the
 * machine. The WhatsApp Web / Steam model.
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
  // trying to link would be a request every 3s, forever, for no reason.
  //
  // This is not merely an optimisation, it is the whole rule: a desktop can
  // become linked ONLY inside the 120s life of a code minted here.
  // `/devices/enroll` answers 403 `desktop_enrollment_requires_approval` for
  // `kind: "desktop"`, so a Mac cannot enrol itself, and the only other path
  // burns a code bound at mint time to this machine's public key. Outside that
  // window no transition can happen, so a poll cannot observe one.
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
          <strong>Linked</strong> — this computer belongs to your account.
        </p>
      ) : link.state === 'no_identity' ? (
        // A dead end until 2026-08-22, and reachable by accident: this is what
        // a dismissed or not-yet-unlocked login keychain looks like, and the
        // access prompt returns on every update while the app is ad-hoc
        // signed. The failure is no longer remembered for the life of the
        // process (`DesktopAuth::device_auth`), so a second attempt can
        // genuinely succeed — but only if something asks for one, and nothing
        // on this screen did.
        <div data-testid="link-state-no-identity">
          <p className="error">
            Lilypad couldn’t save this computer’s key to the macOS keychain, so it can’t be linked
            yet. If a keychain permission box appeared, allow it and try again.
          </p>
          <div className="row">
            <button className="btn" data-testid="retry-identity" onClick={refresh}>
              Try again
            </button>
          </div>
        </div>
      ) : link.state === 'unknown' ? (
        // NOT "not linked": we do not know, and saying the wrong one invites a
        // linked user to redo a ceremony they already completed.
        <p className="muted" data-testid="link-state-unknown">
          Can’t reach Lilypad’s server, so the account status is unknown right now.
        </p>
      ) : (
        <p className="muted" data-testid="link-state-unlinked">
          <strong>Not linked</strong> —{' '}
          {link.state === 'revoked'
            ? 'access to this computer was revoked. Link it again to restore it.'
            : 'no account owns this computer yet. Pairing still works; linking is what makes it yours.'}
        </p>
      )}

      {!linked && link?.state !== 'no_identity' ? (
        <>
          {enrollment ? (
            <div className="account__enroll">
              <p className="muted">
                On your phone: open Lilypad, sign in, then scan this code to add this computer to
                your account.
              </p>
              <div className={`qr__frame ${expired ? 'qr__frame--expired' : ''}`}>
                {dataUrl ? (
                  <img src={dataUrl} alt="Link this computer" width={200} height={200} />
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
              {enrollment ? 'New code' : 'Link this computer'}
            </button>
          </div>
        </>
      ) : null}

      {error ? <p className="error">{error}</p> : null}
    </section>
  );
}
