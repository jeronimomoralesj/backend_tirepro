-- =============================================================================
-- Catalog datasheet module — per-distributor SKU photos + download tracking.
-- Additive only: two new tables + one enum. No changes to existing rows.
-- =============================================================================

CREATE TYPE "CatalogPriceMode" AS ENUM ('none', 'sin_iva', 'con_iva');

-- ── catalog_images ──────────────────────────────────────────────────────────
-- Photos a distributor uploads to personalize a catalog SKU in their own
-- view. Scoped to companyId so one dist's uploads never surface in
-- another's UI (TirePro admin reads across all companies).
CREATE TABLE "catalog_images" (
  "id"          TEXT         NOT NULL,
  "catalogId"   TEXT         NOT NULL,
  "companyId"   TEXT         NOT NULL,
  "url"         TEXT         NOT NULL,
  "coverIndex"  INTEGER      NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "catalog_images_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "catalog_images_catalogId_companyId_idx"
  ON "catalog_images"("catalogId", "companyId");
CREATE INDEX "catalog_images_companyId_idx"
  ON "catalog_images"("companyId");

ALTER TABLE "catalog_images"
  ADD CONSTRAINT "catalog_images_catalogId_fkey"
    FOREIGN KEY ("catalogId") REFERENCES "tire_master_catalog"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "catalog_images"
  ADD CONSTRAINT "catalog_images_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ── catalog_downloads ───────────────────────────────────────────────────────
-- One row per PDF export. Drives the sales-manager dashboard: who's
-- exporting what, how often, and with what pricing posture.
CREATE TABLE "catalog_downloads" (
  "id"              TEXT                NOT NULL,
  "userId"          TEXT                NOT NULL,
  "companyId"      TEXT                NOT NULL,
  "catalogId"       TEXT                NOT NULL,
  "priceMode"       "CatalogPriceMode"  NOT NULL DEFAULT 'none',
  "priceCop"        DOUBLE PRECISION,
  "fieldsIncluded"  JSONB,
  "ip"              TEXT,
  "userAgent"       TEXT,
  "createdAt"       TIMESTAMP(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "catalog_downloads_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "catalog_downloads_companyId_createdAt_idx"
  ON "catalog_downloads"("companyId", "createdAt");
CREATE INDEX "catalog_downloads_companyId_userId_createdAt_idx"
  ON "catalog_downloads"("companyId", "userId", "createdAt");
CREATE INDEX "catalog_downloads_companyId_catalogId_idx"
  ON "catalog_downloads"("companyId", "catalogId");
CREATE INDEX "catalog_downloads_userId_createdAt_idx"
  ON "catalog_downloads"("userId", "createdAt");

ALTER TABLE "catalog_downloads"
  ADD CONSTRAINT "catalog_downloads_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "catalog_downloads"
  ADD CONSTRAINT "catalog_downloads_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "catalog_downloads"
  ADD CONSTRAINT "catalog_downloads_catalogId_fkey"
    FOREIGN KEY ("catalogId") REFERENCES "tire_master_catalog"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
