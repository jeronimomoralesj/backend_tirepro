-- AlterTable: add delivery-mode columns to marketplace_orders.
-- deliveryMode default 'domicilio' so every existing order remains
-- a shipping order (no behaviour change). pickupPointId / Name /
-- City stay null for shipping orders.
ALTER TABLE "marketplace_orders"
  ADD COLUMN "deliveryMode"    TEXT NOT NULL DEFAULT 'domicilio',
  ADD COLUMN "pickupPointId"   TEXT,
  ADD COLUMN "pickupPointName" TEXT,
  ADD COLUMN "pickupCity"      TEXT;

-- CreateTable: RetailSource
-- One per DistributorListing (UNIQUE listingId). Cascade delete when
-- the listing goes away — the source can't outlive its product.
CREATE TABLE "retail_sources" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "domain" TEXT,
    "priceHtmlSnippet" TEXT,
    "stockHtmlSnippet" TEXT,
    "lastPriceCop" INTEGER,
    "lastFetchedAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastError" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "retail_sources_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "retail_sources_listingId_key" ON "retail_sources"("listingId");
CREATE INDEX "retail_sources_isActive_idx" ON "retail_sources"("isActive");

ALTER TABLE "retail_sources"
  ADD CONSTRAINT "retail_sources_listingId_fkey"
  FOREIGN KEY ("listingId") REFERENCES "distributor_listings"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: RetailPickupPoint
-- Cascades from source — deleting the source wipes its points.
CREATE TABLE "retail_pickup_points" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "externalId" TEXT,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "city" TEXT NOT NULL,
    "cityDisplay" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "hours" TEXT,
    "stockUnits" INTEGER NOT NULL DEFAULT 0,
    "refreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retail_pickup_points_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "retail_pickup_points_sourceId_externalId_key"
  ON "retail_pickup_points"("sourceId", "externalId");
CREATE INDEX "retail_pickup_points_sourceId_city_idx"
  ON "retail_pickup_points"("sourceId", "city");
CREATE INDEX "retail_pickup_points_sourceId_stockUnits_idx"
  ON "retail_pickup_points"("sourceId", "stockUnits");

ALTER TABLE "retail_pickup_points"
  ADD CONSTRAINT "retail_pickup_points_sourceId_fkey"
  FOREIGN KEY ("sourceId") REFERENCES "retail_sources"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
