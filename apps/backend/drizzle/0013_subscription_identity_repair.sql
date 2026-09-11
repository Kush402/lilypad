-- Repair the environment 0012 had to guess, and index the id ownership is
-- actually decided on (L-308, L-309).
--
-- ## What 0012 could not know
--
-- The column it back-filled from, `users.apple_original_transaction_id`,
-- never recorded which Apple environment the receipt came from, so 0012 wrote
-- the literal 'Production' for every legacy subscriber. For a Sandbox receipt
-- that is wrong in the worst direction: a test purchase becomes an ordinary
-- commercial entitlement, which is exactly the defect the environment column
-- was introduced to close (L-298).
--
-- ## How a wrong one is recognised
--
-- Two facts together, and neither alone is enough:
--
--   * `last_transaction_id IS NULL` — no verified Apple event has ever been
--     applied to the row. Every row the notification handler or a client
--     receipt has touched carries the transaction it applied. A row without
--     one exists only because 0012 invented it.
--   * the same `original_transaction_id` also exists under another
--     environment — so Apple is demonstrably talking about this subscription
--     somewhere else, and that other row is the one carrying real events.
--
-- A legacy row that Apple has since confirmed keeps its transaction id and is
-- left alone. A legacy row for a subscription that exists nowhere else is
-- also left alone: there is no evidence against it, and deleting it would
-- take away access this migration cannot prove is wrong.
DELETE FROM "subscriptions" AS "guessed"
WHERE "guessed"."environment" = 'Production'
  AND "guessed"."last_transaction_id" IS NULL
  AND EXISTS (
    SELECT 1 FROM "subscriptions" AS "confirmed"
    WHERE "confirmed"."original_transaction_id" = "guessed"."original_transaction_id"
      AND "confirmed"."environment" <> "guessed"."environment"
  );
--> statement-breakpoint
-- Ownership is refused across environments now (L-308), which asks "does any
-- account already own this original transaction id" on every claim. The
-- identity index is on (environment, original_transaction_id) and cannot
-- answer that without scanning.
CREATE INDEX IF NOT EXISTS "subscriptions_original_transaction_idx"
  ON "subscriptions" ("original_transaction_id");
