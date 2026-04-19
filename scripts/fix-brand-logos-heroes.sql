-- =============================================================================
-- Replace broken Clearbit logos with Google's favicon service (reliable,
-- no API key) and add deterministic hero banners via picsum.photos
-- (free, always up, seeded per brand so each gets a unique-but-stable image).
--
-- Leaves pirelli/continental/hankook alone (user request: already curated).
-- Leaves admin-customized logoUrl / heroImageUrl untouched via WHERE clauses.
--
-- Usage:
--   psql "$DATABASE_URL" -f scripts/fix-brand-logos-heroes.sql
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1) Logos: overwrite the broken Clearbit URLs with Google favicons.
--    Google returns a real logo at 256px for any domain with a published
--    favicon. For brands without a website, leaves logoUrl null so the
--    frontend falls back to the initial-letter avatar.
-- -----------------------------------------------------------------------------
UPDATE brand_info
SET "logoUrl" =
  'https://www.google.com/s2/favicons?sz=256&domain=' ||
  REGEXP_REPLACE(website, '^https?://(www\.)?', '')
WHERE website IS NOT NULL
  AND (
    "logoUrl" IS NULL
    OR "logoUrl" LIKE '%logo.clearbit.com%'   -- our broken Clearbit seeds
  )
  AND slug NOT IN ('pirelli', 'continental', 'hankook');

-- -----------------------------------------------------------------------------
-- 2) Hero images: deterministic landscape via picsum.photos/seed/{slug}.
--    Same slug always returns the same beautiful photo, so each brand page
--    has a consistent identity across refreshes. 1600×500 is a clean
--    banner aspect ratio for the brand hero section.
--
--    Only sets rows where heroImageUrl is currently null so custom admin
--    uploads are preserved.
-- -----------------------------------------------------------------------------
UPDATE brand_info
SET "heroImageUrl" = 'https://picsum.photos/seed/' || slug || '/1600/500'
WHERE "heroImageUrl" IS NULL
  AND slug NOT IN ('pirelli', 'continental', 'hankook');

COMMIT;
