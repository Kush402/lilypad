/**
 * Apple StoreKit / App Store Server Notifications → `users.tier`
 * ([ADR-0016](../../../../docs/adr/0016-storekit-and-the-price.md)).
 *
 * The phone posts a JWS; ASSN posts lifecycle events. Both land here. The
 * only product that grants Pro today is `PRO_MONTHLY_PRODUCT_ID`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import {
  Environment,
  SignedDataVerifier,
  VerificationException,
  type JWSTransactionDecodedPayload,
  type ResponseBodyV2DecodedPayload,
} from '@apple/app-store-server-library';
import { PRO_MONTHLY_PRODUCT_ID, type BillingStatus } from '@lilypad/protocol';
import { db as defaultDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { applySubscriptionEvent, subscriptionForOwner } from './subscriptionStore.js';
import {
  effectiveTier,
  subscriptionIsCurrent,
  type AppleEnvironment,
  type SubscriptionEvent,
} from './subscription.js';
import { config } from '../config.js';
import { log } from '../logging.js';

const CERTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../certs/apple');

/** Product ids that mean Pro. Team is not sold through StoreKit. */
const PRO_PRODUCTS = new Set<string>([PRO_MONTHLY_PRODUCT_ID]);

function loadAppleRootCertificates(): Buffer[] {
  return readdirSync(CERTS_DIR)
    .filter((name) => name.endsWith('.cer'))
    .map((name) => readFileSync(join(CERTS_DIR, name)));
}

function environmentFromConfig(): Environment {
  return config.env.APPLE_IAP_ENVIRONMENT === 'Production'
    ? Environment.PRODUCTION
    : Environment.SANDBOX;
}

let verifier: SignedDataVerifier | null = null;
let sandboxFallback: SignedDataVerifier | null = null;

/**
 * Build verifiers once. Production also keeps a Sandbox verifier: a TestFlight
 * build posts Sandbox JWS even when the server is configured for Production,
 * and refusing those would make every TestFlight purchase look like a forgery.
 */
function verifiers(): { primary: SignedDataVerifier; sandbox: SignedDataVerifier | null } {
  if (!verifier) {
    const roots = loadAppleRootCertificates();
    const bundleId = config.env.APPLE_IAP_BUNDLE_ID;
    const appAppleId = config.env.APPLE_APP_APPLE_ID;
    const env = environmentFromConfig();
    verifier = new SignedDataVerifier(
      roots,
      /* enableOnlineChecks */ true,
      env,
      bundleId,
      env === Environment.PRODUCTION ? appAppleId : undefined,
    );
    if (env === Environment.PRODUCTION) {
      sandboxFallback = new SignedDataVerifier(
        roots,
        true,
        Environment.SANDBOX,
        bundleId,
        undefined,
      );
    }
  }
  return { primary: verifier, sandbox: sandboxFallback };
}

export type ApplyResult =
  | { ok: true; status: BillingStatus }
  | {
      ok: false;
      error:
        | 'invalid_transaction'
        | 'wrong_product'
        | 'already_linked'
        | 'wrong_account'
        | 'not_configured';
    };

/** Which environment this deployment sells in. A Sandbox subscription does
 *  not entitle an ordinary account here (L-298). */
function commercialEnvironment(): AppleEnvironment {
  return config.env.APPLE_IAP_ENVIRONMENT === 'Production' ? 'Production' : 'Sandbox';
}

/**
 * A verified transaction, normalized — environment included, which is the
 * half that used to be verified and then discarded (L-298).
 */
function toEvent(
  tx: JWSTransactionDecodedPayload,
  environment: AppleEnvironment,
  notificationType?: string | null,
  graceExpiresAt?: number | null,
): SubscriptionEvent | null {
  if (!tx.originalTransactionId || !tx.productId) return null;
  return {
    environment,
    originalTransactionId: tx.originalTransactionId,
    transactionId: tx.transactionId ?? tx.originalTransactionId,
    productId: tx.productId,
    // Apple's own clock for this transaction. Arrival order is what is
    // unreliable, so it is never used for ordering.
    purchaseDate: tx.purchaseDate ?? tx.signedDate ?? 0,
    expiresAt: tx.expiresDate ?? null,
    revocationDate: tx.revocationDate ?? null,
    notificationType: notificationType ?? null,
    graceExpiresAt: graceExpiresAt ?? null,
  };
}

/** The account's manual grant plus its Apple subscription, as one answer. */
async function statusFor(
  userId: string,
  database: typeof defaultDb,
  now = Date.now(),
): Promise<BillingStatus | null> {
  const [account] = await database
    .select({ tier: users.tier, isBillingTester: users.isBillingTester })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!account) return null;
  const state = await subscriptionForOwner(database, userId, commercialEnvironment());
  const tier = effectiveTier({
    manualTier: account.tier,
    subscription: state,
    commercialEnvironment: commercialEnvironment(),
    isApprovedTester: account.isBillingTester,
    now,
  });
  // Only describe a period that is actually in force. Reporting the end date
  // of a subscription that stopped entitling is how "Pro until…" outlived the
  // subscription it described.
  const current = state != null && subscriptionIsCurrent(state, now);
  // A live subscription that buys nothing here, because Apple sold it in the
  // test environment and this account is not an approved tester. Refusing it
  // is L-298; saying so is L-307. `free` on its own is indistinguishable from
  // "you never bought anything", which is what made a successful TestFlight
  // purchase look like a broken one.
  const testPurchase =
    current && state!.environment !== commercialEnvironment() && !account.isBillingTester;
  return {
    tier,
    productId: current ? state!.productId : null,
    currentPeriodEndsAt:
      current && state!.expiresAt != null ? new Date(state!.expiresAt).toISOString() : null,
    testPurchase,
  };
}

/**
 * Verify a transaction JWS and say **which environment accepted it**.
 *
 * The Sandbox fallback stays: a TestFlight build posts Sandbox receipts even
 * against a Production server, and refusing them would make every tester's
 * purchase look like a forgery. What changes is that the answer is carried
 * instead of discarded — the fallback used to be invisible by the time the
 * tier was written, so a Sandbox purchase bought ordinary production Pro
 * (L-298).
 */
async function decodeTransaction(
  signedTransaction: string,
): Promise<{ tx: JWSTransactionDecodedPayload; environment: AppleEnvironment } | null> {
  const { primary, sandbox } = verifiers();
  const configured = commercialEnvironment();
  try {
    const tx = await primary.verifyAndDecodeTransaction(signedTransaction);
    return { tx, environment: (tx.environment as AppleEnvironment) ?? configured };
  } catch (err) {
    if (sandbox && err instanceof VerificationException) {
      try {
        const tx = await sandbox.verifyAndDecodeTransaction(signedTransaction);
        return { tx, environment: (tx.environment as AppleEnvironment) ?? 'Sandbox' };
      } catch {
        /* fall through */
      }
    }
    log.server.warn({ err }, 'Apple transaction JWS failed verification');
    return null;
  }
}

/**
 * Attach a verified Apple transaction to this Lilypad account.
 *
 * What this no longer does: write `users.tier`. The account's tier is the
 * manual grant now, and an Apple purchase on a Team account records the
 * subscription and changes nothing about what they can do (L-299). What the
 * person is entitled to is derived from both, every time it is asked.
 */
export async function applySignedTransaction(
  userId: string,
  signedTransaction: string,
  database = defaultDb,
): Promise<ApplyResult> {
  try {
    verifiers();
  } catch (err) {
    log.server.error({ err }, 'Apple billing certs missing');
    return { ok: false, error: 'not_configured' };
  }

  const decoded = await decodeTransaction(signedTransaction);
  if (!decoded) return { ok: false, error: 'invalid_transaction' };
  const event = toEvent(decoded.tx, decoded.environment);
  if (!event) return { ok: false, error: 'invalid_transaction' };
  if (!PRO_PRODUCTS.has(event.productId)) {
    return { ok: false, error: 'wrong_product' };
  }
  // Apple's own statement of whose purchase this is, set by the app at purchase
  // time and carried inside the signed transaction (L-297). Where it is
  // present it decides, because it is signed and the caller's claim is not: a
  // delivery that outlived a sign-out must not attach to whoever is holding a
  // token now. Absent on purchases made before the stamp existed, and on
  // purchases made outside the app -- those fall back to the ownership rules,
  // which already refuse a subscription another account holds.
  const stamped = decoded.tx.appAccountToken;
  if (typeof stamped === 'string' && stamped.length > 0 && stamped !== userId) {
    log.server.warn(
      { userId, stamped },
      'Apple transaction was bought for a different Lilypad account',
    );
    return { ok: false, error: 'wrong_account' };
  }

  const { conflict } = await applySubscriptionEvent(database, event, userId);
  if (conflict) return { ok: false, error: 'already_linked' };

  const status = await statusFor(userId, database);
  if (!status) return { ok: false, error: 'invalid_transaction' };
  return { ok: true, status };
}

/**
 * What this account may do right now.
 *
 * Derived from the current period rather than read from a stored word, so an
 * expired subscription whose notification never arrived stops entitling on
 * its own (L-294).
 */
export async function billingStatusFor(
  userId: string,
  database = defaultDb,
): Promise<BillingStatus | null> {
  return statusFor(userId, database);
}

/**
 * Apply an App Store Server Notification V2.
 *
 * An event for a subscription no account has claimed yet is **kept**, not
 * discarded: Apple's first notification routinely beats the phone's receipt,
 * and the row it creates is claimed by the first client that presents a
 * receipt for the same identity (L-296).
 */
export async function applyNotificationPayload(
  signedPayload: string,
  database = defaultDb,
): Promise<{ handled: boolean; reason?: string }> {
  try {
    verifiers();
  } catch {
    return { handled: false, reason: 'not_configured' };
  }

  const { primary, sandbox } = verifiers();
  let decoded: ResponseBodyV2DecodedPayload;
  try {
    decoded = await primary.verifyAndDecodeNotification(signedPayload);
  } catch (err) {
    if (sandbox) {
      try {
        decoded = await sandbox.verifyAndDecodeNotification(signedPayload);
      } catch (err2) {
        log.server.warn({ err: err2 }, 'ASSN payload failed verification');
        return { handled: false, reason: 'invalid_payload' };
      }
    } else {
      log.server.warn({ err }, 'ASSN payload failed verification');
      return { handled: false, reason: 'invalid_payload' };
    }
  }

  const signedTx = decoded.data?.signedTransactionInfo;
  if (!signedTx) {
    // TEST / some subtypes carry no transaction — acknowledge.
    return { handled: true, reason: 'no_transaction' };
  }

  const verified = await decodeTransaction(signedTx);
  if (!verified) return { handled: false, reason: 'invalid_transaction' };

  // Apple states a grace period on the renewal info, not the transaction.
  const graceRaw = (decoded.data as { signedRenewalInfo?: unknown } | undefined)?.signedRenewalInfo;
  const event = toEvent(
    verified.tx,
    verified.environment,
    decoded.notificationType ?? null,
    typeof graceRaw === 'object' && graceRaw !== null
      ? ((graceRaw as { gracePeriodExpiresDate?: number }).gracePeriodExpiresDate ?? null)
      : null,
  );
  if (!event) return { handled: false, reason: 'invalid_transaction' };

  // `null` claimant: a notification never assigns ownership, it only ever
  // updates the subscription it names.
  const { state } = await applySubscriptionEvent(database, event, null);
  if (state.ownerUserId == null) {
    log.server.info(
      { originalTransactionId: event.originalTransactionId, type: decoded.notificationType },
      'ASSN for a subscription no account has claimed — kept for association',
    );
    return { handled: true, reason: 'unclaimed' };
  }
  log.server.info(
    { userId: state.ownerUserId, type: decoded.notificationType, status: state.status },
    'subscription state updated',
  );
  return { handled: true };
}

/** Whether billing env + certs look ready. Used to answer 503 honestly. */
export function appleBillingConfigured(): boolean {
  try {
    const roots = loadAppleRootCertificates();
    if (roots.length === 0) return false;
    if (
      config.env.APPLE_IAP_ENVIRONMENT === 'Production' &&
      config.env.APPLE_APP_APPLE_ID == null
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
