-- Add Bold payment provider support to marketplace_payments.
--   - `provider` distinguishes Wompi vs Bold rows (defaults to 'bold' for new
--     checkouts; existing rows are backfilled to 'wompi' below).
--   - `boldOrderId` is the reference we send to Bold (lookup key on webhook).
--   - `boldPaymentId` is Bold's internal id, populated when the webhook
--     arrives.
--   - `wompiReference` is loosened to nullable so Bold-only rows don't need
--     to fake one. The unique index already tolerates NULLs in Postgres.

ALTER TABLE "marketplace_payments"
  ADD COLUMN "provider"      TEXT NOT NULL DEFAULT 'bold',
  ADD COLUMN "boldOrderId"   TEXT,
  ADD COLUMN "boldPaymentId" TEXT;

-- Backfill existing rows (which all came from Wompi) so the provider column
-- is honest about what's already in the table.
UPDATE "marketplace_payments" SET "provider" = 'wompi' WHERE "provider" = 'bold';

-- Drop NOT NULL on the legacy Wompi reference. Bold rows don't carry one.
ALTER TABLE "marketplace_payments" ALTER COLUMN "wompiReference" DROP NOT NULL;

CREATE UNIQUE INDEX "marketplace_payments_boldOrderId_key"   ON "marketplace_payments"("boldOrderId");
CREATE UNIQUE INDEX "marketplace_payments_boldPaymentId_key" ON "marketplace_payments"("boldPaymentId");
