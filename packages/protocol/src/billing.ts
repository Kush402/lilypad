import { z } from 'zod';

/**
 * Billing wire shapes for StoreKit → control plane
 * ([ADR-0016](../../adr/0016-storekit-and-the-price.md)).
 *
 * The phone posts Apple's signed transaction; the server alone decides
 * `users.tier`. Clients never assert a tier of their own.
 */

/** The only product Lilypad sells today. Kept in protocol so backend and
 * mobile cannot drift on the string App Store Connect minted. */
export const PRO_MONTHLY_PRODUCT_ID = 'com.takedia.lilypad.pro.monthly' as const;

export const BillingTierSchema = z.enum(['free', 'pro', 'team']);
export type BillingTier = z.infer<typeof BillingTierSchema>;

export const BillingStatusSchema = z.object({
  tier: BillingTierSchema,
  productId: z.string().nullable(),
  /** ISO-8601 instant when the current paid period ends, or null. */
  currentPeriodEndsAt: z.string().datetime({ offset: true }).nullable(),
});
export type BillingStatus = z.infer<typeof BillingStatusSchema>;

/** Phone → backend after a StoreKit 2 purchase or restore. */
export const AppleTransactionSubmitSchema = z.object({
  /** Compact JWS from StoreKit (`Transaction.jwsRepresentation`). */
  signedTransaction: z.string().min(32).max(32_768),
});
export type AppleTransactionSubmit = z.infer<typeof AppleTransactionSubmitSchema>;

/** App Store Server Notifications V2 body — Apple posts this, not the phone. */
export const AppleNotificationV2Schema = z.object({
  signedPayload: z.string().min(32).max(262_144),
});
export type AppleNotificationV2 = z.infer<typeof AppleNotificationV2Schema>;
