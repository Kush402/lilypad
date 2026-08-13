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

export function AccountPanel() {
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
  useEffect(() => {
    if (!enrollment || linked) return;
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [enrollment, linked, refresh]);

  // The code stops being useful the moment the phone approves.
  useEffect(() => {
    if (linked) {
      setEnrollment(null);
      setDataUrl('');
    }
  }, [linked]);

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

  const expired = enrollment !== null && secondsLeft <= 0;

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
        <p className="error" data-testid="link-state-no-identity">
          This computer has no secure identity, so it cannot be linked. Lilypad could not store a
          key in the keychain.
        </p>
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
