-- Five foreign keys that had no index on the referencing side.
--
-- Postgres does not create one automatically, and the omission costs twice:
-- the ordinary lookup degrades to a sequential scan, and every ON DELETE
-- CASCADE / SET NULL from the parent must scan this whole table to find the
-- rows it has to touch. Deleting one account was getting slower for every row
-- anybody else had ever written — and `audit_logs` grows without bound.
--
-- Plain CREATE INDEX rather than CONCURRENTLY: these tables are small today
-- (hundreds of rows), a Drizzle migration runs inside a transaction, and
-- CONCURRENTLY cannot. At a size where the SHARE lock would be felt, this
-- needs to be run by hand with CONCURRENTLY instead.

CREATE INDEX "audit_logs_user_idx" ON "audit_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_logs_device_idx" ON "audit_logs" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "devices_user_idx" ON "devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "trusted_devices_user_idx" ON "trusted_devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "trusted_devices_mobile_idx" ON "trusted_devices" USING btree ("mobile_device_id");