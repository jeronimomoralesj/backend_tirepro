-- Distributor slug column. Drives keyword-rich URLs like
-- /marketplace/distributor/merquellantas instead of opaque UUIDs, which
-- rank significantly better in search and look better in shares/links.
--
-- Strategy:
--   1. Add nullable slug column.
--   2. Enable the unaccent extension so backfill can strip Spanish accents.
--   3. Backfill all existing companies — distributors keep slugs even if
--      their plan changes later, and non-distributors getting a slug is
--      harmless and avoids edge-cases when a non-distributor company
--      decides to publish listings.
--   4. Resolve collisions by appending a numeric suffix to duplicates,
--      keeping the oldest row's slug bare (Merquellantas keeps "merquellantas",
--      a later "Merquellantas SAS" becomes "merquellantas-2").
--   5. Add unique index now that every row has a value.

CREATE EXTENSION IF NOT EXISTS unaccent;

ALTER TABLE "Company" ADD COLUMN "slug" TEXT;

-- Step 3: backfill from name. Pipeline:
--   unaccent       → "México"        → "Mexico"
--   lower          → "Mexico"        → "mexico"
--   regexp \W → '-' → "merquellantas s.a.s." → "merquellantas-s-a-s-"
--   regexp '-+'    → collapse runs of dashes to a single dash
--   trim '-'       → strip leading/trailing dashes
UPDATE "Company"
SET "slug" = trim(both '-' from regexp_replace(
                    regexp_replace(
                      lower(unaccent("name")),
                      '[^a-z0-9]+', '-', 'g'
                    ),
                    '-+', '-', 'g'
                  ))
WHERE "slug" IS NULL;

-- Anything that ended up empty (e.g. a name that was all symbols) gets a
-- fallback derived from the id so the unique index still holds.
UPDATE "Company"
SET "slug" = 'company-' || substr("id", 1, 8)
WHERE "slug" IS NULL OR "slug" = '';

-- Step 4: collision resolution. Lowest createdAt wins the bare slug; later
-- rows get -2, -3, ... suffixes.
WITH ranked AS (
  SELECT
    "id",
    "slug",
    ROW_NUMBER() OVER (PARTITION BY "slug" ORDER BY "createdAt", "id") AS rn
  FROM "Company"
  WHERE "slug" IS NOT NULL
)
UPDATE "Company" c
SET "slug" = ranked."slug" || '-' || ranked.rn
FROM ranked
WHERE c."id" = ranked."id" AND ranked.rn > 1;

-- Step 5: enforce uniqueness going forward.
CREATE UNIQUE INDEX "Company_slug_key" ON "Company"("slug");
