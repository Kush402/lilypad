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
import { and, eq, ne } from 'drizzle-orm';
import {
  Environment,
  NotificationTypeV2,
  SignedDataVerifier,
  VerificationException,
  type JWSTransactionDecodedPayload,
  type ResponseBodyV2DecodedPayload,
} from '@apple/app-store-server-library';
import { PRO_MONTHLY_PRODUCT_ID, type BillingStatus } from '@lilypad/protocol';
import { db as defaultDb } from '../db/client.js';
import { users } from '../db/schema.js';
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
  | { ok: false; error: 'invalid_transaction' | 'wrong_product' | 'already_linked' | 'not_configured' };

function toStatus(row: {
  tier: 'free' | 'pro' | 'team';
  subscriptionProductId: string | null;
  subscriptionExpiresAt: Date | null;
}): BillingStatus {
  return {
    tier: row.tier,
    productId: row.subscriptionProductId,
    currentPeriodEndsAt: row.subscriptionExpiresAt
      ? row.subscriptionExpiresAt.toISOString()
      : null,
  };
}

function expiresAtFromTx(tx: JWSTransactionDecodedPayload): Date | null {
  if (tx.expiresDate == null) return null;
  return new Date(tx.expiresDate);
}

function isCurrentlyEntitled(tx: JWSTransactionDecodedPayload, now = Date.now()): boolean {
  if (tx.revocationDate != null) return false;
  if (tx.expiresDate != null && tx.expiresDate <= now) return false;
  return PRO_PRODUCTS.has(tx.productId ?? '');
}

async function decodeTransaction(
  signedTransaction: string,
): Promise<JWSTransactionDecodedPayload | null> {
  const { primary, sandbox } = verifiers();
  try {
    return await primary.verifyAndDecodeTransaction(signedTransaction);
  } catch (err) {
    if (sandbox && err instanceof VerificationException) {
      try {
        return await sandbox.verifyAndDecodeTransaction(signedTransaction);
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
 * Fails closed on an unknown product, a revoked/expired transaction, and on
 * an originalTransactionId already owned by a different account.
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

  const tx = await decodeTransaction(signedTransaction);
  if (!tx?.originalTransactionId || !tx.productId) {
    return { ok: false, error: 'invalid_transaction' };
  }
  if (!PRO_PRODUCTS.has(tx.productId)) {
    return { ok: false, error: 'wrong_product' };
  }

  const entitled = isCurrentlyEntitled(tx);
  const expiresAt = expiresAtFromTx(tx);
  const originalId = tx.originalTransactionId;

  // Another account already holds this Apple subscription.
  const [conflict] = await database
    .select({ id: users.id })
    .from(users)
    .where(
      and(eq(users.appleOriginalTransactionId, originalId), ne(users.id, userId)),
    )
    .limit(1);
  if (conflict) return { ok: false, error: 'already_linked' };

  if (!entitled) {
    // Restore of an expired sub: clear Apple linkage if it was ours, leave
    // tier alone when this account is `team` (not sold via StoreKit).
    const [row] = await database
      .select({
        tier: users.tier,
        subscriptionProductId: users.subscriptionProductId,
        subscriptionExpiresAt: users.subscriptionExpiresAt,
        appleOriginalTransactionId: users.appleOriginalTransactionId,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!row) return { ok: false, error: 'invalid_transaction' };
    if (row.appleOriginalTransactionId === originalId && row.tier === 'pro') {
      await database
        .update(users)
        .set({
          tier: 'free',
          appleOriginalTransactionId: null,
          subscriptionProductId: null,
          subscriptionExpiresAt: expiresAt,
        })
        .where(eq(users.id, userId));
      return {
        ok: true,
        status: {
          tier: 'free',
          productId: null,
          currentPeriodEndsAt: expiresAt ? expiresAt.toISOString() : null,
        },
      };
    }
    return { ok: true, status: toStatus(row) };
  }

  await database
    .update(users)
    .set({
      tier: 'pro',
      appleOriginalTransactionId: originalId,
      subscriptionProductId: tx.productId,
      subscriptionExpiresAt: expiresAt,
    })
    .where(eq(users.id, userId));

  return {
    ok: true,
    status: {
      tier: 'pro',
      productId: tx.productId,
      currentPeriodEndsAt: expiresAt ? expiresAt.toISOString() : null,
    },
  };
}

export async function billingStatusFor(
  userId: string,
  database = defaultDb,
): Promise<BillingStatus | null> {
  const [row] = await database
    .select({
      tier: users.tier,
      subscriptionProductId: users.subscriptionProductId,
      subscriptionExpiresAt: users.subscriptionExpiresAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row ? toStatus(row) : null;
}

/**
 * Apply an App Store Server Notification V2.
 *
 * Looks up the account by `originalTransactionId`. Unknown ids are acknowledged
 * (200) rather than retried forever — Apple will keep sending until we do.
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

  const tx = await decodeTransaction(signedTx);
  if (!tx?.originalTransactionId) {
    return { handled: false, reason: 'invalid_transaction' };
  }

  const [account] = await database
    .select({
      id: users.id,
      tier: users.tier,
    })
    .from(users)
    .where(eq(users.appleOriginalTransactionId, tx.originalTransactionId))
    .limit(1);

  if (!account) {
    // Purchase on a device that has not posted the JWS yet, or a foreign app.
    log.server.info(
      { originalTransactionId: tx.originalTransactionId, type: decoded.notificationType },
      'ASSN for unknown Lilypad account — acknowledged',
    );
    return { handled: true, reason: 'unknown_account' };
  }

  const type = decoded.notificationType;
  const dropTypes = new Set<string>([
    NotificationTypeV2.EXPIRED,
    NotificationTypeV2.REVOKE,
    NotificationTypeV2.REFUND,
    NotificationTypeV2.GRACE_PERIOD_EXPIRED,
  ]);

  if (dropTypes.has(type ?? '') || !isCurrentlyEntitled(tx)) {
    if (account.tier === 'team') {
      // Team is not StoreKit-managed; leave it alone.
      return { handled: true, reason: 'team_untouched' };
    }
    await database
      .update(users)
      .set({
        tier: 'free',
        appleOriginalTransactionId: null,
        subscriptionProductId: null,
        subscriptionExpiresAt: expiresAtFromTx(tx),
      })
      .where(eq(users.id, account.id));
    log.server.info(
      { userId: account.id, type },
      'subscription ended — account returned to free',
    );
    return { handled: true };
  }

  if (PRO_PRODUCTS.has(tx.productId ?? '')) {
    await database
      .update(users)
      .set({
        tier: 'pro',
        subscriptionProductId: tx.productId ?? PRO_MONTHLY_PRODUCT_ID,
        subscriptionExpiresAt: expiresAtFromTx(tx),
      })
      .where(eq(users.id, account.id));
  }

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
