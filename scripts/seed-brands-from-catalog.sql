-- =============================================================================
-- Seed brand_info from every distinct brand in the TireMasterCatalog so
-- the marketplace's /marketplace/brand/[slug] pages exist for every SKU
-- brand we sell.
--
-- Idempotent: ON CONFLICT (name/slug) DO NOTHING. Re-running only adds new
-- brands that appeared in the catalog since the last run; existing rows
-- (and any admin-edited fields like logoUrl / description / tier) are
-- preserved.
--
-- Defaults for fresh rows:
--   • name     = INITCAP of the trimmed catalog brand
--   • slug     = lowercase-alphanumeric-with-hyphens
--   • tier     = 'value' (upgrade known-premium brands manually)
--   • source   = 'catalog' (marks auto-seeded vs manual/wikipedia entries)
--   • published = true    (visible immediately; flip to false to hide)
--
-- Usage:
--   psql "$DATABASE_URL" -f scripts/seed-brands-from-catalog.sql
-- =============================================================================

BEGIN;

WITH brand_candidates AS (
  -- Distinct normalized brand from every SKU in the catalog. Excludes
  -- empty / null / one-character noise so we don't create junk entries.
  SELECT DISTINCT
    TRIM(marca)                                 AS raw_name,
    LOWER(TRIM(marca))                          AS norm_name,
    -- URL slug: lowercase, non-alphanumerics to hyphens, collapse + trim.
    REGEXP_REPLACE(
      REGEXP_REPLACE(
        TRIM(BOTH '-' FROM LOWER(REGEXP_REPLACE(TRIM(marca), '[^a-zA-Z0-9]+', '-', 'g'))),
        '--+', '-', 'g'
      ),
      '^-|-$', '', 'g'
    )                                           AS slug
  FROM tire_master_catalog
  WHERE marca IS NOT NULL
    AND LENGTH(TRIM(marca)) >= 2
),
dedup AS (
  -- Multiple catalog spellings may collapse to the same slug
  -- ("MICHELIN" / "Michelin" / "michelin "). Pick one per slug.
  SELECT DISTINCT ON (slug)
    slug,
    raw_name,
    norm_name
  FROM brand_candidates
  WHERE slug <> ''
  ORDER BY slug, raw_name
)
INSERT INTO brand_info (
  id, name, slug, tier, source, published, "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(),
  INITCAP(raw_name),
  slug,
  'value',
  'catalog',
  true,
  NOW(),
  NOW()
FROM dedup
-- Skip anything already present under either key. The existing 4 rows
-- (Continental, Michelin-tier placeholders, etc.) keep their curated data.
ON CONFLICT (slug) DO NOTHING;

-- Upgrade known premium / mid-tier brands so the star rating on their
-- marketplace page matches reality. Covers the usual Colombia lineup.
UPDATE brand_info SET tier = 'premium'
WHERE slug IN ('michelin', 'bridgestone', 'continental', 'goodyear', 'pirelli', 'dunlop')
  AND tier = 'value';

UPDATE brand_info SET tier = 'mid'
WHERE slug IN ('hankook', 'yokohama', 'kumho', 'toyo', 'falken', 'nexen',
               'general', 'firestone', 'bfgoodrich', 'laufenn', 'maxxis',
               'nitto', 'cooper', 'uniroyal')
  AND tier = 'value';

COMMIT;
