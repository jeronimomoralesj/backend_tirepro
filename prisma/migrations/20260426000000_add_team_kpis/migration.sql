-- =============================================================================
-- TeamKpi — admin-defined inspection goals per company/user/period.
-- Additive only: new enums + new table + FKs. Safe on live data.
-- =============================================================================

CREATE TYPE "KpiMetric" AS ENUM ('vehicles_inspected', 'clients_inspected', 'tires_inspected');
CREATE TYPE "KpiPeriod" AS ENUM ('weekly', 'monthly', 'quarterly', 'custom');

CREATE TABLE "team_kpis" (
  "id"          TEXT         NOT NULL,
  "companyId"   TEXT         NOT NULL,
  "userId"      TEXT,
  "metric"      "KpiMetric"  NOT NULL,
  "period"      "KpiPeriod"  NOT NULL,
  "periodStart" DATE         NOT NULL,
  "periodEnd"   DATE         NOT NULL,
  "target"      INTEGER      NOT NULL,
  "notas"       TEXT,
  "createdById" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "team_kpis_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "team_kpis_companyId_periodStart_idx"
  ON "team_kpis"("companyId", "periodStart");
CREATE INDEX "team_kpis_companyId_userId_metric_periodStart_idx"
  ON "team_kpis"("companyId", "userId", "metric", "periodStart");

ALTER TABLE "team_kpis"
  ADD CONSTRAINT "team_kpis_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "team_kpis"
  ADD CONSTRAINT "team_kpis_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
