-- Postgres-managed generated column. Pre-computes
-- LEAST(cantidadDisponible, 50) so the marketplace listings query
-- can sort by it directly (cheap btree scan) instead of doing the
-- LEAST() in every ORDER BY. The cap means a listing with 200 units
-- ranks the same as one with 50 — both can cover any reasonable
-- single order, so we don't want sheer stockpile to dominate the
-- ranking past that point.
--
-- GENERATED ALWAYS AS ... STORED → Postgres recomputes on every
-- INSERT/UPDATE of cantidadDisponible. Application code must never
-- write to this column directly (Prisma model declares it as
-- nullable so it gets omitted from INSERT payloads).
ALTER TABLE "distributor_listings"
  ADD COLUMN IF NOT EXISTS "inventoryRank" INT
  GENERATED ALWAYS AS (LEAST("cantidadDisponible", 50)) STORED;

-- Backs the new orderBy. Combined with `isActive` so the marketplace
-- listings query can resolve the sort using a single index range scan.
CREATE INDEX IF NOT EXISTS "distributor_listings_isActive_inventoryRank_idx"
  ON "distributor_listings" ("isActive", "inventoryRank");
