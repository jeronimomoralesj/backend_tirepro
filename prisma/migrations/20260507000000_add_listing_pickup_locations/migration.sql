-- Distributor-managed pickup points per listing. Used when a listing's
-- deliveryMode is "pickup" or "both" AND there's no retailSource
-- connected — the dist enters their own bodegas by hand on the
-- listing edit form. Buyer's PickupChooser merges these with any
-- retailer-scraped points so the city-grouped UX stays consistent.
CREATE TABLE IF NOT EXISTS "listing_pickup_locations" (
  "id"                   TEXT PRIMARY KEY,
  "distributorListingId" TEXT NOT NULL,
  "name"                 TEXT NOT NULL,
  "address"              TEXT,
  "city"                 TEXT NOT NULL,
  "cityDisplay"          TEXT,
  "lat"                  DOUBLE PRECISION,
  "lng"                  DOUBLE PRECISION,
  "hours"                TEXT,
  "stockUnits"           INTEGER NOT NULL DEFAULT 0,
  "isActive"             BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,
  CONSTRAINT "listing_pickup_locations_listing_fk"
    FOREIGN KEY ("distributorListingId") REFERENCES "distributor_listings"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "listing_pickup_locations_listing_active_idx"
  ON "listing_pickup_locations" ("distributorListingId", "isActive");
CREATE INDEX IF NOT EXISTS "listing_pickup_locations_listing_city_idx"
  ON "listing_pickup_locations" ("distributorListingId", "city");
