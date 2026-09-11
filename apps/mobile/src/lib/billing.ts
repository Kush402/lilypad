import { accessToken, DeviceAuthError, unauthorizedError } from './auth';
import { UserFacingError } from './errors';
import { AppState } from 'react-native';
import {
  finishTransaction,
  onTransactionsChanged,
  getProduct,
  purchaseProduct,
  restorePurchases,
  unfinishedTransactions,
  PRO_MONTHLY_PRODUCT_ID,
} from './storekit';
import { loadSession } from './session';

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
  const session = await loadSession();
  const purchase = await purchaseProduct(PRO_MONTHLY_PRODUCT_ID, session?.userId ?? null);

  let status: BillingStatus;
  try {
    status = await submitAppleTransaction(apiBaseUrl, purchase.signedTransactionInfo);
  } catch (err) {
    // The money has moved and the transaction is still unfinished, so Apple
    // will keep offering it and `deliverPendingPurchases` will keep trying.
    // Saying "purchase failed" here would be false, and it is what sent people
    // hunting for a Restore button (L-297).
    if (err instanceof DeviceAuthError) throw err;
    throw new BillingError(
      'Your purchase went through. Lilypad could not record it just yet, but it will finish on its own. Reopen this screen to check.',
    );
  }

  // Delivered. Only now may StoreKit stop offering it.
  await finishTransaction(purchase.transactionId).catch(() => undefined);
  return status;
}

/** What one drain did, for logging and for the tests. */
export type DeliveryOutcome = {
  /** Recorded by the control plane and finished with StoreKit. */
  delivered: number;
  /** Still unfinished, deliberately: it will be offered again. */
  held: number;
};

/**
 * Deliver every purchase Apple still considers undelivered (L-297).
 *
 * Run on launch, on foreground, and whenever StoreKit nudges. It is the
 * recovery path for the interval this defect was about: charged, then the
 * network or the process or the server went away before Lilypad recorded it.
 *
 * A failure here is not an error to report. The transaction stays unfinished,
 * which means Apple offers it again next time — retrying quietly is the whole
 * design, and a modal apology for a purchase that will arrive by itself is
 * worse than silence.
 */
export async function deliverPendingPurchases(apiBaseUrl: string): Promise<DeliveryOutcome> {
  let pending: Awaited<ReturnType<typeof unfinishedTransactions>>;
  try {
    pending = await unfinishedTransactions();
  } catch {
    return { delivered: 0, held: 0 };
  }
  if (pending.length === 0) return { delivered: 0, held: 0 };

  const session = await loadSession();
  let delivered = 0;
  let held = 0;

  for (const purchase of pending) {
    // Apple's own stamp of whose purchase this is. A delivery that outlived a
    // sign-out must not be handed to whoever happens to be signed in now.
    if (
      purchase.appAccountToken != null &&
      session?.userId != null &&
      purchase.appAccountToken !== session.userId
    ) {
      held += 1;
      continue;
    }
    try {
      await submitAppleTransaction(apiBaseUrl, purchase.signedTransactionInfo);
      await finishTransaction(purchase.transactionId);
      delivered += 1;
    } catch {
      // Signed out, offline, or the server said no. It stays queued.
      held += 1;
    }
  }
  return { delivered, held };
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

/**
 * Keep delivering paid-for purchases, for as long as the app is running.
 *
 * Three triggers, all leading to the same drain: launch, returning to the
 * foreground, and Apple's nudge that its set of transactions changed. The
 * nudge is the only one that can be missed — `RCTEventEmitter` drops an event
 * when nothing is listening — which is why the other two exist and why the
 * nudge carries no payload.
 *
 * Silent by design. A purchase that has not reached the server yet is not
 * something to interrupt a person about; it is something to keep trying.
 */
export function startPurchaseDelivery(): { stop: () => void } {
  let draining = false;

  const drain = async (): Promise<void> => {
    // Three triggers can fire at once on a cold foreground. Delivering the
    // same transaction twice is safe -- submission is idempotent by
    // transaction id -- but there is no reason to do it.
    if (draining) return;
    draining = true;
    try {
      const session = await loadSession();
      if (session == null) return;
      await deliverPendingPurchases(session.apiBaseUrl);
    } catch {
      /* the transaction is still unfinished; the next trigger tries again */
    } finally {
      draining = false;
    }
  };

  void drain();
  const nudge = onTransactionsChanged(() => {
    void drain();
  });
  const appState = AppState.addEventListener('change', (next) => {
    if (next === 'active') void drain();
  });

  return {
    stop: () => {
      nudge.remove();
      appState.remove();
    },
  };
}
