import { Platform } from 'react-native';
import type { PairingRedeemResponse } from '@lilypad/protocol';
import { getDeviceId } from './device';
import { RedeemError, classifyHttpStatus, classifyFetchError } from './errors';

/** Bounded so a slow/dead network surfaces as a classified, actionable error
 * instead of a spinner that never resolves. See
 * `docs/audit/m3/mobile-ux.md` Finding 2. */
const REDEEM_TIMEOUT_MS = 8_000;

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
    const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/pairing/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token,
        deviceId: getDeviceId(),
        deviceName: `${Platform.OS} phone`,
        platform: Platform.OS === 'ios' ? 'ios' : 'android',
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new RedeemError(classifyHttpStatus(res.status, text));
    }
    return (await res.json()) as PairingRedeemResponse;
  } catch (err) {
    if (err instanceof RedeemError) throw err;
    throw new RedeemError(classifyFetchError(timedOut));
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
}
