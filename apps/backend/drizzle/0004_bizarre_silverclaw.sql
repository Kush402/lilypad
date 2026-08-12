ALTER TABLE "refresh_tokens" DROP CONSTRAINT "refresh_tokens_device_id_devices_id_fk";
--> statement-breakpoint
ALTER TABLE "refresh_tokens" DROP COLUMN "device_id";