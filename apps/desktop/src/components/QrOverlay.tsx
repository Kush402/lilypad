import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { api, type QrPayloadDto } from '../lib/tauri';

/** Build the exact JSON the mobile scanner expects (see @lilypad/protocol QrPayload). */
function toQrString(p: QrPayloadDto): string {
  return JSON.stringify({
    v: 2,
    token: p.token,
    roomId: p.roomId,
    apiBaseUrl: p.apiBaseUrl,
    signalingUrl: p.signalingUrl,
    deviceName: p.deviceName,
    platform: p.platform,
  });
}

export function QrOverlay() {
  const [payload, setPayload] = useState<QrPayloadDto | null>(null);
  const [dataUrl, setDataUrl] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [secondsLeft, setSecondsLeft] = useState<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Avoids a stale-closure read of `payload` inside `generate` without
  // re-creating the callback (and re-running the mount effect) every time
  // a fresh payload arrives.
  const hasPayloadRef = useRef(false);
  // Collapses concurrent generates into one pairing: StrictMode double-runs
  // the mount effect in dev, and a rapid "New code" double-click does the
  // same in prod — each extra call minted a room whose session runner
  // instantly overwrote the previous one's control channel.
  const inFlightRef = useRef(false);
  // Set when a "New code" click would be disruptive (a phone already has an
  // approval pending or a live session) — surfaces an inline confirm instead
  // of gating on `window.confirm`, which returns falsy in Tauri's wry
  // webview and would silently swallow every regenerate. See
  // `docs/audit/m3/desktop-ux.md` Finding 9.
  const [pendingDisruptiveRegen, setPendingDisruptiveRegen] = useState(false);

  const doGenerate = useCallback(async () => {
    if (inFlightRef.current) return;
    setPendingDisruptiveRegen(false);
    setError('');
    setDataUrl('');
    inFlightRef.current = true;
    try {
      const p = await api.createPairing();
      hasPayloadRef.current = true;
      setPayload(p);
      setSecondsLeft(p.expiresInSeconds);
      const url = await QRCode.toDataURL(toQrString(p), {
        margin: 1,
        width: 240,
        color: { dark: '#0b3d2e', light: '#ffffff' },
      });
      setDataUrl(url);
    } catch (err) {
      // Both of these are expected and already handled by the Rust command,
      // which opens the window carrying the step that is actually missing —
      // Setup for permissions, the dashboard for linking. Rendering them as
      // errors here would put a red string on top of the screen that already
      // says what to do.
      const handled = ['permissions_required', 'link_required'];
      if (!handled.includes(String(err))) setError(String(err));
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  // Entry point for both the mount effect and the "New code"/"Regenerate"
  // button. Regenerating is only harmless when nothing else is at stake —
  // if a phone has already redeemed the token (an approval is pending or a
  // session is live), regenerating silently ends it (`create_pairing`
  // always spawns a fresh session runner, overwriting the control channel
  // the current one depends on). In that case, surface the inline confirm
  // instead of proceeding; never confirm the FIRST code a window shows. See
  // `docs/audit/m3/desktop-ux.md` Finding 9.
  const generate = useCallback(async () => {
    if (inFlightRef.current) return;
    if (hasPayloadRef.current) {
      const current = await api.getState().catch(() => null);
      const disruptive = current?.session === 'awaiting_approval' || current?.session === 'active';
      if (disruptive) {
        setPendingDisruptiveRegen(true);
        return;
      }
    }
    void doGenerate();
  }, [doGenerate]);

  useEffect(() => {
    void generate();
  }, [generate]);

  // Countdown to token expiry (60s).
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (secondsLeft <= 0) return;
    timerRef.current = setInterval(() => {
      setSecondsLeft((s) => Math.max(0, s - 1));
    }, 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [payload, secondsLeft]);

  const expired = secondsLeft <= 0 && !!payload;

  return (
    <div className="page qr">
      <h1>Scan to pair</h1>
      <p className="muted">Open Lilypad on your phone and scan this code.</p>

      <div className={`qr__frame ${expired ? 'qr__frame--expired' : ''}`}>
        {dataUrl ? <img src={dataUrl} alt="Pairing QR code" width={240} height={240} /> : null}
        {expired ? <div className="qr__expired-badge">Expired</div> : null}
      </div>

      {/* No prefix. The Rust side now returns a whole sentence written for
          the reader, and "Could not reach backend: …" on top of it named the
          wrong cause twice — a 429 is not an unreachable backend. */}
      {error ? <p className="error">{error}</p> : null}

      {/* Only the countdown. This used to also show `Room a1b2c3d4…`, a
          truncated internal identifier, on the screen a customer stares at
          while lining up their camera — nothing they can read, act on, or
          repeat. The room id is a support fact, and support facts live in the
          Diagnostics window, which can copy them. */}
      {payload ? (
        <dl className="qr__meta">
          <div>
            <dt>Expires in</dt>
            <dd>{secondsLeft}s</dd>
          </div>
        </dl>
      ) : null}

      {pendingDisruptiveRegen ? (
        <div className="revoke-confirm">
          <p className="muted">This will end the current pending request or session. Continue?</p>
          <div className="row revoke-confirm__actions">
            <button className="btn btn--danger btn--small" onClick={() => void doGenerate()}>
              Confirm
            </button>
            <button
              className="btn btn--ghost btn--small"
              onClick={() => setPendingDisruptiveRegen(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <div className="row">
        <button className="btn" onClick={() => void generate()}>
          {expired ? 'Regenerate' : 'New code'}
        </button>
        {/* DEV-only (M1): simulate a phone redeeming, so Approve/Deny is
            drivable without a real device. Compiled out of production
            bundles entirely (`import.meta.env.DEV` is statically false in a
            `vite build`, so this whole branch is dead-code-eliminated) — the
            backend command also refuses outside a debug build as a
            defense-in-depth backstop. See
            docs/audit/m3/desktop-ux.md Finding 7. */}
        {import.meta.env.DEV ? (
          <button className="btn btn--ghost" onClick={() => void api.simulatePairRequest()}>
            Simulate phone scan
          </button>
        ) : null}
      </div>
    </div>
  );
}
