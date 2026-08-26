import { accessToken, DeviceAuthError, unauthorizedError } from './auth';
import { UserFacingError } from './errors';
import { getProduct, purchaseProduct, restorePurchases, PRO_MONTHLY_PRODUCT_ID } from './storekit';

/**
 * Account billing against the control plane
 * ([ADR-0016](../../../../docs/adr/0016-storekit-and-the-price.md)).
 *
 * StoreKit is the cash register; this module is the receipt book. The phone
 * never writes `users.tier` itself — it posts Apple's JWS and trusts the
 * status the server returns after verification.
 */

const REQUEST_TIMEOUT_MS = 8_000;

/** What GET /billing/status (and a successful transaction POST) answer. */
export type BillingStatus = {
  tier: 'free' | 'pro' | 'team';
  /** Active subscription product id when the account is entitled via Apple. */
  productId: string | null;
  /** When the current paid period ends, ISO-8601, or null when unknown / free. */
  currentPeriodEndsAt: string | null;
};

export class BillingError extends UserFacingError {}

async function request(
  apiBaseUrl: string,
  path: string,
  init: { method: string; body?: unknown },
): Promise<Response> {
  const token = await accessToken(apiBaseUrl); // throws DeviceAuthError if not signed in
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${token}`,
        // ONLY when there is a body. Fastify rejects a request that declares
        // `application/json` and then sends nothing with
        // `FST_ERR_CTP_EMPTY_JSON_BODY` — same trap as accountDevices.ts.
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: controller.signal,
    });
    if (res.status === 401) throw unauthorizedError(await res.text().catch(() => ''));
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function billingFailure(status: number): string {
  if (status === 429) return 'Too many requests just now. Wait a moment, then try again.';
  if (status >= 500) {
    return 'Lilypad’s server is having trouble with billing. Try again in a moment.';
  }
  return 'Could not update your subscription. Check your connection and try again.';
}

/** Current entitlement for this account. */
export async function fetchBillingStatus(apiBaseUrl: string): Promise<BillingStatus> {
  let res: Response;
  try {
    res = await request(apiBaseUrl, '/billing/status', { method: 'GET' });
  } catch (err) {
    if (err instanceof DeviceAuthError) throw err;
    throw new BillingError('Could not reach Lilypad. Check your connection.');
  }
  if (!res.ok) throw new BillingError(billingFailure(res.status));
  return (await res.json()) as BillingStatus;
}

/**
 * Hand Apple's signed transaction to the control plane.
 *
 * Field name on the wire is `signedTransaction` (App Store Server API vocabulary),
 * not the StoreKit property name `signedTransactionInfo`.
 */
export async function submitAppleTransaction(
  apiBaseUrl: string,
  signedTransactionInfo: string,
): Promise<BillingStatus> {
  let res: Response;
  try {
    res = await request(apiBaseUrl, '/billing/apple/transactions', {
      method: 'POST',
      body: { signedTransaction: signedTransactionInfo },
    });
  } catch (err) {
    if (err instanceof DeviceAuthError) throw err;
    if (err instanceof UserFacingError) throw err;
    throw new BillingError('Could not reach Lilypad. Check your connection.');
  }
  if (!res.ok) throw new BillingError(billingFailure(res.status));
  return (await res.json()) as BillingStatus;
}

/**
 * Buy Pro: load the product (disclosure / availability), purchase, submit JWS.
 *
 * Loading the product first fails fast when App Store Connect has nothing to
 * sell, instead of opening an empty purchase sheet.
 */
export async function purchasePro(apiBaseUrl: string): Promise<BillingStatus> {
  await getProduct(PRO_MONTHLY_PRODUCT_ID);
  const purchase = await purchaseProduct(PRO_MONTHLY_PRODUCT_ID);
  return submitAppleTransaction(apiBaseUrl, purchase.signedTransactionInfo);
}

/**
 * Restore: sync entitlements, submit every JWS, return the last status.
 *
 * Empty entitlements are a real answer ("this Apple ID has nothing"), not a
 * network failure — surface that so the UI does not claim a restore succeeded.
 */
export async function restorePro(apiBaseUrl: string): Promise<BillingStatus> {
  const purchases = await restorePurchases();
  if (purchases.length === 0) {
    throw new BillingError('No purchases to restore on this Apple ID.');
  }
  let status: BillingStatus | null = null;
  for (const purchase of purchases) {
    status = await submitAppleTransaction(apiBaseUrl, purchase.signedTransactionInfo);
  }
  // Loop always assigns when length > 0; the null check keeps TypeScript honest.
  return status ?? (await fetchBillingStatus(apiBaseUrl));
}
