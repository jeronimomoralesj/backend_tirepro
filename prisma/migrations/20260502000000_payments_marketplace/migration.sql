-- Marketplace payments + payouts. See schema.prisma comment block on
-- DistributorPaymentAccount for the full money-flow rationale.

-- ============================================================================
-- DistributorPaymentAccount — one per distribuidor company.
-- ============================================================================
CREATE TABLE IF NOT EXISTS "distributor_payment_accounts" (
  "id"                TEXT PRIMARY KEY,
  "companyId"         TEXT NOT NULL UNIQUE,
  "holderName"        TEXT NOT NULL,
  "documentType"      TEXT NOT NULL,
  "documentNumber"    TEXT NOT NULL,
  "bankName"          TEXT NOT NULL,
  "accountType"       TEXT NOT NULL,
  "accountNumber"     TEXT NOT NULL,
  "notificationEmail" TEXT,
  "verifiedAt"        TIMESTAMP(3),
  "notes"             TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "distributor_payment_accounts_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE
);

-- ============================================================================
-- Payment — one per buyer transaction (can cover multiple orders).
-- ============================================================================
CREATE TABLE IF NOT EXISTS "marketplace_payments" (
  "id"                 TEXT PRIMARY KEY,
  "wompiTransactionId" TEXT UNIQUE,
  "wompiReference"     TEXT NOT NULL UNIQUE,
  "paymentMethod"      TEXT,
  "status"             TEXT NOT NULL DEFAULT 'pending',
  "grossCop"           DOUBLE PRECISION NOT NULL,
  "feeCop"             DOUBLE PRECISION NOT NULL,
  "netCop"             DOUBLE PRECISION NOT NULL,
  "buyerEmail"         TEXT NOT NULL,
  "paidAt"             TIMESTAMP(3),
  "rawWebhookData"     JSONB,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL
);

-- ============================================================================
-- Payout — aggregated release to a distributor.
-- ============================================================================
CREATE TABLE IF NOT EXISTS "marketplace_payouts" (
  "id"                  TEXT PRIMARY KEY,
  "distributorId"       TEXT NOT NULL,
  "bankAccountId"       TEXT NOT NULL,
  "amountCop"           DOUBLE PRECISION NOT NULL,
  "status"              TEXT NOT NULL DEFAULT 'pending_release',
  "releasedAt"          TIMESTAMP(3),
  "releasedByUserId"    TEXT,
  "bankReferenceNumber" TEXT,
  "notes"               TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "marketplace_payouts_distributorId_fkey"
    FOREIGN KEY ("distributorId") REFERENCES "Company"("id"),
  CONSTRAINT "marketplace_payouts_bankAccountId_fkey"
    FOREIGN KEY ("bankAccountId") REFERENCES "distributor_payment_accounts"("id")
);

CREATE INDEX IF NOT EXISTS "marketplace_payouts_distributorId_status_idx"
  ON "marketplace_payouts" ("distributorId", "status");

-- ============================================================================
-- MarketplaceOrder — link to Payment + Payout, plus the per-order money split.
-- ============================================================================
ALTER TABLE "marketplace_orders" ADD COLUMN IF NOT EXISTS "paymentId" TEXT;
ALTER TABLE "marketplace_orders" ADD COLUMN IF NOT EXISTS "payoutId"  TEXT;
ALTER TABLE "marketplace_orders" ADD COLUMN IF NOT EXISTS "feeCop"    DOUBLE PRECISION;
ALTER TABLE "marketplace_orders" ADD COLUMN IF NOT EXISTS "netCop"    DOUBLE PRECISION;

ALTER TABLE "marketplace_orders"
  ADD CONSTRAINT "marketplace_orders_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "marketplace_payments"("id") ON DELETE SET NULL;

ALTER TABLE "marketplace_orders"
  ADD CONSTRAINT "marketplace_orders_payoutId_fkey"
  FOREIGN KEY ("payoutId") REFERENCES "marketplace_payouts"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "marketplace_orders_payoutId_idx"
  ON "marketplace_orders" ("payoutId");
