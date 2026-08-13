-- SEC-5 — revoke trust pairs that carry no connect secret.
--
-- These rows predate the per-pair secret (M5.4). `authorizeConnect` used to
-- admit them with no secret at all for back-compat, so knowing a desktop and a
-- mobile device id was sufficient to ring someone's laptop — on exactly the
-- pairs whose owners never had the chance to opt into a secret.
--
-- Revoked rather than deleted, matching how Forget and Revoke already work: the
-- row is the audit trail, and the connect gate fails closed from now on. The
-- affected phones re-pair once with a QR, which issues a secret and un-revokes
-- the row (`establishTrustForDeviceIds`).
--
-- The column stays nullable: a secret cannot be backfilled — it is only ever
-- known to the phone it was issued to — so NOT NULL would have to invent one.
-- `authorizeConnect` refuses a null hash outright, which is the real guard.
UPDATE "trusted_devices"
SET "revoked_at" = now()
WHERE "connect_secret_hash" IS NULL
  AND "revoked_at" IS NULL;
