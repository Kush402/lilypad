import { NativeModules, Platform } from 'react-native';
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
};

type LilypadStoreKitNative = {
  getProduct(productId: string): Promise<StoreKitProduct>;
  purchase(productId: string): Promise<StoreKitPurchase>;
  restore(): Promise<StoreKitPurchase[]>;
  latestTransaction(productId: string): Promise<StoreKitPurchase | null>;
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

/** Present Apple's purchase sheet and return the signed transaction. */
export async function purchaseProduct(
  productId: string = PRO_MONTHLY_PRODUCT_ID,
): Promise<StoreKitPurchase> {
  try {
    return await nativeModule().purchase(productId);
  } catch (err) {
    mapNativeError(err, 'Could not complete the purchase. Try again.');
  }
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
