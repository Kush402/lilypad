-- Undoes one index from 0008. `trusted_devices.user_id` is written by nothing
-- and read by nothing — verified against production, where every row has it
-- NULL — so indexing it was covering a foreign key that never carries a value.
-- The cascade that actually cleans a deleted account's pairs runs through
-- `devices`, whose keys ARE indexed. See the column's comment in schema.ts.

DROP INDEX "trusted_devices_user_idx";