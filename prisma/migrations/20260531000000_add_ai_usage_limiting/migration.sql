-- Per-company monthly AI quota override (NULL => plan default).
ALTER TABLE "Company" ADD COLUMN "aiMonthlyLimit" INTEGER;

-- One row per AI request: drives request-count quotas + cost analytics.
CREATE TABLE "ai_usage_events" (
  "id"               TEXT NOT NULL,
  "companyId"        TEXT NOT NULL,
  "userId"           TEXT,
  "feature"          TEXT NOT NULL,
  "model"            TEXT,
  "inputTokens"      INTEGER NOT NULL DEFAULT 0,
  "outputTokens"     INTEGER NOT NULL DEFAULT 0,
  "estimatedCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_usage_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ai_usage_events_companyId_createdAt_idx" ON "ai_usage_events" ("companyId", "createdAt");
CREATE INDEX "ai_usage_events_userId_createdAt_idx" ON "ai_usage_events" ("userId", "createdAt");
