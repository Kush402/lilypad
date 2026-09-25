ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "tier_expires_at" timestamp with time zone;
