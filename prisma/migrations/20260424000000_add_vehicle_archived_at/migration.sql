-- =============================================================================
-- Add archival column to Vehicle + index. Queries scoped by companyId now
-- filter on archivedAt IS NULL to hide retired vehicles without deleting
-- the row.
-- =============================================================================

ALTER TABLE "Vehicle" ADD COLUMN "archivedAt" TIMESTAMP(3);

CREATE INDEX "Vehicle_companyId_archivedAt_idx" ON "Vehicle"("companyId", "archivedAt");
