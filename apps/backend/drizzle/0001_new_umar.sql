ALTER TABLE "trusted_devices" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "public_key" text;--> statement-breakpoint
ALTER TABLE "trusted_devices" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "trusted_devices" ADD COLUMN "auto_approve" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "trusted_devices" ADD COLUMN "last_connected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trusted_devices" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "trusted_devices_pair_idx" ON "trusted_devices" USING btree ("desktop_device_id","mobile_device_id");