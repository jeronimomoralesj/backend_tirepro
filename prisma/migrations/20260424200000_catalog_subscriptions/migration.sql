-- Per-distributor subscription to a master-catalog SKU. Distributors now
-- curate which tires appear in their catalog view; everything dist-side
-- (search, detail, edit, images, video, PDF) is filtered through this
-- table. Starts empty for new dists.

CREATE TABLE "catalog_subscriptions" (
  "catalogId"     TEXT         NOT NULL,
  "companyId"     TEXT         NOT NULL,
  "addedByUserId" TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "catalog_subscriptions_pkey" PRIMARY KEY ("catalogId", "companyId")
);

CREATE INDEX "catalog_subscriptions_companyId_createdAt_idx"
  ON "catalog_subscriptions"("companyId", "createdAt");

ALTER TABLE "catalog_subscriptions"
  ADD CONSTRAINT "catalog_subscriptions_catalogId_fkey"
    FOREIGN KEY ("catalogId") REFERENCES "tire_master_catalog"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "catalog_subscriptions"
  ADD CONSTRAINT "catalog_subscriptions_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill — preserve existing dist visibility. Any (catalogId, companyId)
-- pair already associated with an image, video, or download becomes an
-- auto-subscription so working distributors don't suddenly see an empty
-- catalog on deploy.
INSERT INTO "catalog_subscriptions" ("catalogId", "companyId")
  SELECT DISTINCT "catalogId", "companyId" FROM "catalog_images"
  UNION
  SELECT DISTINCT "catalogId", "companyId" FROM "catalog_videos"
  UNION
  SELECT DISTINCT "catalogId", "companyId" FROM "catalog_downloads"
ON CONFLICT ("catalogId", "companyId") DO NOTHING;
