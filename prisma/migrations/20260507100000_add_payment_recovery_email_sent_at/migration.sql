-- Abandoned-cart recovery: tracks whether we've already nudged the
-- buyer about a Bold/Wompi payment that's still `pending` past the
-- 24h threshold. The AbandonedCartCron sets this once and uses it
-- as the idempotency gate so a buyer never gets two recovery emails
-- for the same cart.
ALTER TABLE "marketplace_payments"
  ADD COLUMN "recoveryEmailSentAt" TIMESTAMP(3);

-- Composite index on (status, createdAt) — the cron's hot query is
-- "give me pending payments older than 24h", and we want it to run
-- in single-digit ms even with hundreds of thousands of rows.
CREATE INDEX "marketplace_payments_status_createdAt_idx"
  ON "marketplace_payments" ("status", "createdAt");
