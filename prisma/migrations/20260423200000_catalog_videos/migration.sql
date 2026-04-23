-- One instructional / product video per (catalog SKU, distributor). Not
-- embedded in the generated PDF — used as an attachment the salesperson
-- can share with a prospect.

CREATE TABLE "catalog_videos" (
  "id"           TEXT          NOT NULL,
  "catalogId"    TEXT          NOT NULL,
  "companyId"    TEXT          NOT NULL,
  "url"          TEXT          NOT NULL,
  "originalName" TEXT,
  "mimeType"     TEXT,
  "sizeBytes"    INTEGER,
  "createdAt"    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "catalog_videos_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "catalog_videos_catalogId_companyId_key"
  ON "catalog_videos"("catalogId", "companyId");

CREATE INDEX "catalog_videos_companyId_idx"
  ON "catalog_videos"("companyId");

ALTER TABLE "catalog_videos"
  ADD CONSTRAINT "catalog_videos_catalogId_fkey"
    FOREIGN KEY ("catalogId") REFERENCES "tire_master_catalog"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "catalog_videos"
  ADD CONSTRAINT "catalog_videos_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
