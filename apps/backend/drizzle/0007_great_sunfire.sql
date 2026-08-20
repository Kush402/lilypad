ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
-- Backfill: an account is only marked proven where the way it came into
-- existence REQUIRED proof. Redeeming a magic link and a provider's verified
-- email are both proof; typing an address into /auth/signup is not. Accounts
-- created by signup therefore stay NULL and will be claimed (password cleared,
-- sessions revoked) the first time the real inbox owner signs in.
UPDATE "users" SET "email_verified_at" = "created_at"
WHERE "password_hash" IS NULL
   OR EXISTS (SELECT 1 FROM "oauth_identities" WHERE "oauth_identities"."user_id" = "users"."id");
