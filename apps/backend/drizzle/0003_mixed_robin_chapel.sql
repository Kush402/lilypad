-- HAND-EDITED (M8): the generated statements below add a UNIQUE index on
-- devices(kind, fingerprint). `upsertDevice` has always been select-then-insert,
-- so a pre-existing database may already hold the duplicate rows that index
-- forbids, and the migration would fail on deploy.
--
-- Unreferenced duplicates are a plain artefact of the race and are deleted.
-- Duplicates that are BOTH referenced are NOT merged automatically: merging two
-- device rows merges their trust grants, which is a security decision a
-- migration must not make silently. That case stops the deploy with an
-- actionable message instead.
DO $$
DECLARE
  stuck text;
BEGIN
  DELETE FROM devices d
  WHERE EXISTS (
      SELECT 1 FROM devices o
      WHERE o.kind = d.kind AND o.fingerprint = d.fingerprint
        AND (o.created_at, o.id) < (d.created_at, d.id)
    )
    AND NOT EXISTS (SELECT 1 FROM trusted_devices t
                    WHERE t.desktop_device_id = d.id OR t.mobile_device_id = d.id)
    AND NOT EXISTS (SELECT 1 FROM sessions s
                    WHERE s.desktop_device_id = d.id OR s.mobile_device_id = d.id)
    AND NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.device_id = d.id);

  SELECT string_agg(format('%s/%s', kind, fingerprint), ', ')
    INTO stuck
    FROM (SELECT kind, fingerprint FROM devices
          GROUP BY kind, fingerprint HAVING count(*) > 1) dup;

  IF stuck IS NOT NULL THEN
    RAISE EXCEPTION
      'duplicate device rows still referenced by trust/session/audit data: %. '
      'Merge or revoke them by hand before applying this migration.', stuck;
  END IF;
END $$;--> statement-breakpoint
CREATE TYPE "public"."auth_provider" AS ENUM('apple', 'google');--> statement-breakpoint
CREATE TABLE "oauth_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "auth_provider" NOT NULL,
	"subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_identities" ADD CONSTRAINT "oauth_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_identities_provider_subject_idx" ON "oauth_identities" USING btree ("provider","subject");--> statement-breakpoint
CREATE INDEX "oauth_identities_user_idx" ON "oauth_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_kind_fingerprint_idx" ON "devices" USING btree ("kind","fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_public_key_idx" ON "devices" USING btree ("public_key");