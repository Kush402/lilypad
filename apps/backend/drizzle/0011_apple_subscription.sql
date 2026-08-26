ALTER TABLE "users" ADD COLUMN "apple_original_transaction_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "subscription_product_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "subscription_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_apple_original_transaction_id_unique" UNIQUE("apple_original_transaction_id");
