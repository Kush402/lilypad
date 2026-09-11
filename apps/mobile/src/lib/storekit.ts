import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import { UserFacingError } from './errors';

/**
 * StoreKit 2 wrappers for Lilypad Pro
 * ([ADR-0016](../../../../docs/adr/0016-storekit-and-the-price.md)).
 *
 * The native module is iOS-only. Android and Jest (no native binary) must fail
 * with a sentence a person can act on — never a bare `undefined is not a
 * function` from a missing NativeModule.
 */

/** App Store Connect product id for the monthly Pro subscription. */
export const PRO_MONTHLY_PRODUCT_ID = 'com.takedia.lilypad.pro.monthly';

export type StoreKitProduct = {
  productId: string;
  displayName: string;
  description: string;
  displayPrice: string;
  price: number;
  currencyCode: string;
  hasIntroOffer: boolean;
  introOfferLabel: string | null;
};

export type StoreKitPurchase = {
  productId: string;
  originalTransactionId: string;
  transactionId: string;
  /** App Store Server API JWS — what the backend verifies. */
  signedTransactionInfo: string;
  environment: string;
  /**
   * The Lilypad account this purchase was stamped for, inside Apple's signed
   * transaction. `null` for purchases made before the stamp existed, or made
   * outside the app (L-297).
   */
  appAccountToken: string | null;
};

type LilypadStoreKitNative = {
  getProduct(productId: string): Promise<StoreKitProduct>;
  purchase(productId: string, appAccountToken: string | null): Promise<StoreKitPurchase>;
  restore(): Promise<StoreKitPurchase[]>;
  latestTransaction(productId: string): Promise<StoreKitPurchase | null>;
  unfinishedTransactions(): Promise<StoreKitPurchase[]>;
  finishTransaction(transactionId: string): Promise<boolean>;
};

function nativeModule(): LilypadStoreKitNative {
  if (Platform.OS !== 'ios') {
    throw new UserFacingError('Purchases are only available on iPhone and iPad.');
  }
  const mod = NativeModules.LilypadStoreKit as LilypadStoreKitNative | undefined;
  if (!mod) {
    // Tests, and any simulator/build that never linked the Swift module.
    throw new UserFacingError(
      'Purchases are not available in this build. Use a store build of Lilypad to subscribe.',
    );
  }
  return mod;
}

/** Map a native promise rejection onto curated copy. */
function mapNativeError(err: unknown, fallback: string): never {
  if (err instanceof UserFacingError) throw err;
  const code = (err as { code?: string } | null)?.code;
  if (code === 'user_cancelled') {
    throw new UserFacingError('Purchase cancelled.');
  }
  if (code === 'pending') {
    throw new UserFacingError(
      'That purchase is waiting for approval. Try again once it is approved.',
    );
  }
  if (code === 'product_not_found') {
    throw new UserFacingError('That subscription is not available right now. Try again later.');
  }
  const message = err instanceof Error ? err.message : undefined;
  throw new UserFacingError(message && message.length > 0 ? message : fallback);
}

/** Localized product for the purchase disclosure. */
export async function getProduct(
  productId: string = PRO_MONTHLY_PRODUCT_ID,
): Promise<StoreKitProduct> {
  try {
    return await nativeModule().getProduct(productId);
  } catch (err) {
    mapNativeError(err, 'Could not load the subscription from the App Store.');
  }
}

/**
 * Present Apple's purchase sheet and return the signed transaction.
 *
 * The transaction comes back **unfinished** on purpose: finishing it tells
 * StoreKit the purchase has been delivered, and nothing has been delivered
 * until Lilypad's server says so (L-297). Call `finishTransaction` then, and
 * not before.
 */
export async function purchaseProduct(
  productId: string = PRO_MONTHLY_PRODUCT_ID,
  appAccountToken: string | null = null,
): Promise<StoreKitPurchase> {
  try {
    return await nativeModule().purchase(productId, appAccountToken);
  } catch (err) {
    mapNativeError(err, 'Could not complete the purchase. Try again.');
  }
}

/**
 * Everything Apple still considers undelivered.
 *
 * StoreKit is the durable queue of purchases Lilypad has not recorded yet: it
 * outlives a crash, a reinstall and a reboot, which is more than a record of
 * our own would. An empty array is the normal answer.
 */
export async function unfinishedTransactions(): Promise<StoreKitPurchase[]> {
  try {
    return await nativeModule().unfinishedTransactions();
  } catch (err) {
    mapNativeError(err, 'Could not read pending purchases. Try again.');
  }
}

/** Tell StoreKit one transaction has been delivered. Only after the server
 *  has acknowledged it. */
export async function finishTransaction(transactionId: string): Promise<boolean> {
  try {
    return await nativeModule().finishTransaction(transactionId);
  } catch (err) {
    mapNativeError(err, 'Could not complete the purchase. Try again.');
  }
}

/**
 * Apple's nudge that the set of transactions changed — a delayed Ask-to-Buy
 * approval, a renewal, a purchase made on another device.
 *
 * Deliberately payload-free. `RCTEventEmitter` throws an event away when
 * nothing is listening yet, so a design where a missed event costs a delivery
 * would be L-297 again in a new place. The nudge only asks for a drain;
 * `unfinishedTransactions` is what is authoritative.
 */
export function onTransactionsChanged(listener: () => void): { remove: () => void } {
  if (Platform.OS !== 'ios') return { remove: () => {} };
  const mod = NativeModules.LilypadStoreKit;
  if (!mod) return { remove: () => {} };
  const emitter = new NativeEventEmitter(mod as never);
  return emitter.addListener('LilypadStoreKitTransactionsChanged', listener);
}

/** Current entitlements for this Apple ID on this device (after AppStore.sync). */
export async function restorePurchases(): Promise<StoreKitPurchase[]> {
  try {
    return await nativeModule().restore();
  } catch (err) {
    mapNativeError(err, 'Could not restore purchases. Try again.');
  }
}

/** Latest transaction for a product, or null if none. */
export async function latestTransaction(
  productId: string = PRO_MONTHLY_PRODUCT_ID,
): Promise<StoreKitPurchase | null> {
  try {
    return await nativeModule().latestTransaction(productId);
  } catch (err) {
    mapNativeError(err, 'Could not read the latest purchase. Try again.');
  }
}
