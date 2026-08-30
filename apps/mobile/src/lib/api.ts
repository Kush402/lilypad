import { Platform } from 'react-native';
import type { ConnectResponse, PairingRedeemResponse } from '@lilypad/protocol';
import { deviceLabel, initDeviceIdentity } from './device';
import { accessToken, DeviceAuthError, unauthorizedError } from './auth';
import { RedeemError, appError, classifyHttpStatus, classifyFetchError } from './errors';
import { resolveConnectTarget } from './connectPath';
import { lanFetch } from './lanTls';
import type { PairedDesktop } from './pairs';

/** Bounded so a slow/dead network surfaces as a classified, actionable error
 * instead of a spinner that never resolves. See
 * `docs/audit/m3/mobile-ux.md` Finding 2. */
const REDEEM_TIMEOUT_MS = 8_000;

/**
 * Headers proving WHICH phone this is (M9,
 * [ADR-0010](../../../../docs/adr/0010-explicit-device-linking.md)).
 *
 * **Throws `DeviceAuthError` when this phone is on no account**, and callers
 * are expected to route to sign-in rather than send the request anyway.
 *
 * This used to be best-effort: it swallowed the failure and sent no header,
 * because the backend applied a mirror-image rule and demanded a token only
 * for a device an account already owned. That lane is gone — the product model
 * is account → devices, so a phone on no account may not pair, connect or
 * unpair at all. Sending the request regardless would now earn a 404 that the
 * client cannot tell apart from "no such laptop", and the user would be shown
 * a dead end instead of the sign-in screen that actually fixes it.
 */
async function deviceAuthHeaders(apiBaseUrl: string): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await accessToken(apiBaseUrl)}` };
}

/** The best-effort variant, for the one call that must succeed offline. */
async function optionalDeviceAuthHeaders(apiBaseUrl: string): Promise<Record<string, string>> {
  try {
    return await deviceAuthHeaders(apiBaseUrl);
  } catch {
    return {};
  }
}

/**
 * Redeem a scanned pairing token against the backend. This burns the token
 * (single-use) and returns the signaling room the phone should join.
 *
 * `externalSignal`, when given, lets a caller actually cancel the in-flight
 * request (e.g. the user tapping Rescan) instead of merely ignoring its
 * eventual result — see `docs/audit/m3/mobile-ux.md` Finding 7.
 */
export async function redeemToken(
  apiBaseUrl: string,
  token: string,
  externalSignal?: AbortSignal,
): Promise<PairingRedeemResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort);
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REDEEM_TIMEOUT_MS);

  try {
    // The redeem is this identity's FIRST use in any session — awaiting the
    // keychain-backed init here (memoized; instant after app-start warmup)
    // guarantees every later sync getDeviceId() sees the persistent id.
    const deviceId = await initDeviceIdentity();
    // A cancel (Rescan tap, timeout) that landed during that await must not
    // fire the network request at all — and a fetch mock/polyfill handed an
    // already-aborted signal may never settle, so don't rely on fetch to
    // notice.
    if (controller.signal.aborted) {
      throw new RedeemError(classifyFetchError(timedOut));
    }
    const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/pairing/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await deviceAuthHeaders(apiBaseUrl)) },
      body: JSON.stringify({
        token,
        deviceId,
        deviceName: deviceLabel(),
        platform: Platform.OS === 'ios' ? 'ios' : 'android',
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // `classifyHttpStatus` has no 401 branch, so this would land on
      // `unknown` — the least useful thing to say about the one failure with
      // an exact remedy. `ScannerScreen` already sends a `DeviceAuthError` to
      // sign-in and returns to this card.
      if (res.status === 401) throw unauthorizedError(text);
      throw new RedeemError(classifyHttpStatus(res.status, text));
    }
    return (await res.json()) as PairingRedeemResponse;
  } catch (err) {
    if (err instanceof RedeemError) throw err;
    // A phone with no account has a specific remedy — sign in — so it must
    // reach the caller as itself, not flattened into a network error.
    if (err instanceof DeviceAuthError) throw err;
    throw new RedeemError(classifyFetchError(timedOut));
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
}

/** Derive the LAN signaling URL from the API base the probe selected. */
export function lanSignalingUrlFromApiBase(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/\/$/, '').replace(/^https:/, 'wss:')}/ws/signal`;
}

/**
 * A room to join, and — inseparably — the TLS pin that applies to the
 * `signalingUrl` in it.
 *
 * `signalingTlsPin` is set ONLY when the LAN target actually won. It is
 * `undefined` for a cloud room, and that is not an oversight to be helpfully
 * filled in from the saved pair: `api.takedia.com` is a publicly-trusted
 * endpoint that must be validated normally, and pinning it to a laptop's
 * self-signed LAN certificate can only fail.
 *
 * That is the v0.1.21 ring bug, exactly. The URL and the pin used to be
 * sourced independently — this function rewrote `signalingUrl` for a LAN win
 * while every caller reached for `pair.lanTlsCertSha256` unconditionally — so
 * a phone that fell back to cloud (Mac and phone on different campus subnets)
 * opened a cloud socket carrying the Mac's pin. The handshake could never
 * complete, no HTTP upgrade was ever emitted, and the app hung on
 * "Connecting…" forever. Six attempts, no error, no WebSocket in the logs.
 *
 * Returning them as one value is the fix: there is no longer a pin sitting
 * anywhere for a caller to pair up with the wrong URL.
 */
export type ConnectForPairResult = ConnectResponse & {
  /** SHA-256 of the DER cert that `signalingUrl` must present, or `undefined`
   * when `signalingUrl` is a normal publicly-trusted endpoint. */
  signalingTlsPin?: string;
};

export async function requestConnectForPair(
  pair: PairedDesktop,
  opts?: { resume?: boolean },
): Promise<ConnectForPairResult> {
  const cloud = pair.apiBaseUrl.replace(/\/$/, '');
  const target = await resolveConnectTarget(pair);

  const tryConnect = (t: typeof target) =>
    requestConnect(
      t.apiBaseUrl,
      pair.desktopDeviceId,
      pair.connectSecret,
      t.lanTlsCertSha256,
      opts,
    );

  try {
    const res = await tryConnect(target);
    if (target.lanTlsCertSha256 && target.apiBaseUrl !== cloud) {
      // The one branch where a pin belongs, and it travels with the URL it was
      // issued for rather than beside it.
      return {
        ...res,
        signalingUrl: lanSignalingUrlFromApiBase(target.apiBaseUrl),
        signalingTlsPin: target.lanTlsCertSha256,
      };
    }
    return res;
  } catch (err) {
    // LAN `/health` can succeed while offline auth is not ready yet (trust
    // cache empty after an app update). Fall through to cloud — same product
    // rule as the probe budget in NETWORKING.md §3. Note what the cloud result
    // carries: no pin. The LAN attempt losing is precisely why.
    if (target.apiBaseUrl !== cloud) {
      return tryConnect({ apiBaseUrl: cloud });
    }
    throw err;
  }
}

/**
 * Ring a trusted desktop without a QR (M5.4, `POST /connect/request`). On
 * success the response mirrors a redeem, so the caller navigates into the
 * Viewer exactly like the scanner flow. Failures classify into the specific
 * trust codes (`not_trusted`/`trust_revoked`/`desktop_offline`) so the UI
 * can say the honest thing.
 */
export async function requestConnect(
  apiBaseUrl: string,
  desktopDeviceId: string,
  pairSecret?: string,
  lanTlsCertSha256?: string,
  opts?: { resume?: boolean },
): Promise<ConnectResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REDEEM_TIMEOUT_MS);

  try {
    const mobileDeviceId = await initDeviceIdentity();
    const base = apiBaseUrl.replace(/\/$/, '');
    const authHeaders = lanTlsCertSha256
      ? await optionalDeviceAuthHeaders(apiBaseUrl)
      : await deviceAuthHeaders(apiBaseUrl);
    const fetchFn = lanTlsCertSha256
      ? (url: string, init?: RequestInit) => lanFetch(url, lanTlsCertSha256, init)
      : fetch;
    const res = await fetchFn(`${base}/connect/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders },
      body: JSON.stringify({
        desktopDeviceId,
        mobileDeviceId,
        mobileDeviceName: `${Platform.OS} phone`,
        ...(pairSecret ? { pairSecret } : {}),
        ...(opts?.resume ? { resume: true } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // As in `redeemToken`: a revoked phone ringing a laptop is a 401
      // from `rejectRevokedActor`, and "something went wrong" is not what to
      // tell someone whose phone was removed from the account.
      if (res.status === 401) throw unauthorizedError(body);
      throw new RedeemError(classifyConnectStatus(res.status, body));
    }
    return (await res.json()) as ConnectResponse;
  } catch (err) {
    if (err instanceof RedeemError) throw err;
    if (err instanceof DeviceAuthError) throw err;
    throw new RedeemError(classifyFetchError(timedOut));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Best-effort mobile-initiated unpair (`POST /devices/unpair`, the mirror of
 * `requestConnect`). Called when the user "Forgets" a laptop: severs the trust
 * pairing on the backend too, so the laptop's Trusted Devices list stops
 * showing this phone — closing the asymmetry where a phone-side Forget left the
 * pairing alive on the laptop. Deliberately NEVER throws: forgetting must always
 * succeed locally even if the phone is offline or the stored backend address is
 * stale (the laptop can still revoke from its own side later, and a re-pair
 * un-revokes the row cleanly). Resolves to `true` if the backend acknowledged,
 * `false` otherwise — the caller may ignore the result.
 */
export async function requestUnpair(apiBaseUrl: string, desktopDeviceId: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REDEEM_TIMEOUT_MS);
  try {
    const mobileDeviceId = await initDeviceIdentity();
    const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/devices/unpair`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(await optionalDeviceAuthHeaders(apiBaseUrl)),
      },
      body: JSON.stringify({ desktopDeviceId, mobileDeviceId }),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false; // best-effort — offline / stale url / timeout all fine
  } finally {
    clearTimeout(timer);
  }
}

/** Map /connect/request failures onto the error taxonomy. The endpoint's
 * machine codes are authoritative where present; status is the fallback. */
function classifyConnectStatus(status: number, body: string) {
  if (status === 409 && body.includes('session_gone')) return appError('session_gone');
  if (status === 404 && body.includes('not_trusted')) return appError('not_trusted');
  // Before the `revoked` line: a laptop released by its own sign-out is a
  // different fact from a pairing somebody ended, and it has a different
  // remedy. Both are 403s from the same route.
  if (status === 403 && body.includes('desktop_not_on_account'))
    return appError('desktop_not_on_account');
  if (status === 403 && body.includes('revoked')) return appError('trust_revoked');
  if (status === 503 && body.includes('desktop_offline')) return appError('desktop_offline');
  return classifyHttpStatus(status, body);
}
