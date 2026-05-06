-- Postgres-managed generated boolean: true if the listing has any
-- warehouse stock at all. Used as the primary sort key on every
-- marketplace listings query so out-of-stock items always sink to
-- the bottom regardless of the buyer's chosen sort order (price asc,
-- newest, etc.).
--
-- We can't reuse `inventoryRank` here — that's LEAST(cantidad, 50),
-- which causes a "100k → 200k → 150k" zigzag when used as the
-- primary key for price_asc (a 1-unit listing at $100k drops below
-- a 50-unit listing at $200k). A binary in-stock flag avoids the
-- zigzag while still keeping out-of-stock at the bottom.
--
-- Note: this only considers warehouse stock. Listings sold solely
-- through Alkosto/Ktronix bodega pickup (retailSource pickup points)
-- still register false here. We can refine later if the retail-only
-- inventory pool grows.
ALTER TABLE "distributor_listings"
  ADD COLUMN IF NOT EXISTS "inStock" BOOLEAN
  GENERATED ALWAYS AS ("cantidadDisponible" > 0) STORED;

-- Index covers the common sort: filter by isActive, partition by
-- inStock, then resolve secondary keys. Prisma's findMany with our
-- new orderBy `[ { inStock: 'desc' }, { precioCop: 'asc' } ]` can
-- use this index for the first two keys.
CREATE INDEX IF NOT EXISTS "distributor_listings_isActive_inStock_idx"
  ON "distributor_listings" ("isActive", "inStock");
