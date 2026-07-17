-- Runs once on first Postgres container init (before the app connects).
-- The application schema itself is owned by Drizzle migrations
-- (apps/backend/drizzle) — keep table DDL there, not here.

-- gen_random_uuid() is in core since PG13, but enable pgcrypto for any future
-- hashing/crypto helpers used by auth (Milestone 5).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Case-insensitive text for emails (Milestone 5).
CREATE EXTENSION IF NOT EXISTS citext;
