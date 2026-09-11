CREATE TABLE IF NOT EXISTS "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment" text NOT NULL,
	"original_transaction_id" text NOT NULL,
	"owner_user_id" uuid,
	"product_id" text NOT NULL,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone,
	"grace_expires_at" timestamp with time zone,
	"last_transaction_id" text,
	"last_purchase_date" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_identity_idx" ON "subscriptions" ("environment","original_transaction_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscriptions_owner_idx" ON "subscriptions" ("owner_user_id");--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_billing_tester" boolean DEFAULT false NOT NULL;--> statement-breakpoint
INSERT INTO "subscriptions" (
	"environment", "original_transaction_id", "owner_user_id", "product_id",
	"status", "expires_at", "last_purchase_date"
)
SELECT
	'Production',
	"apple_original_transaction_id",
	"id",
	COALESCE("subscription_product_id", 'com.takedia.lilypad.pro.monthly'),
	CASE
		WHEN "subscription_expires_at" IS NOT NULL AND "subscription_expires_at" <= now()
			THEN 'expired'
		ELSE 'active'
	END,
	"subscription_expires_at",
	now()
FROM "users"
WHERE "apple_original_transaction_id" IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- `users.tier` now means the tier granted OUTSIDE Apple. An account that was
-- Pro because of an Apple subscription has that fact in `subscriptions` now,
-- and leaving it in `tier` as well would keep exactly the defect this closes:
-- a stored word that outlives the period it describes (L-294). Team is a
-- manual grant and is left alone.
UPDATE "users"
SET "tier" = 'free'
WHERE "tier" = 'pro' AND "apple_original_transaction_id" IS NOT NULL;
