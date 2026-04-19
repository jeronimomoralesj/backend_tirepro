-- =============================================================================
-- Null out every broken/unreliable logoUrl so the frontend falls back
-- cleanly to the initial-letter avatar instead of showing a 404 image
-- icon.
--
-- What we're nulling:
--   • Clearbit (logo.clearbit.com) — service paywalled, returns 402
--   • Google favicons — often return a 1x1 transparent pixel or a tiny
--     generic globe when the site has no favicon, which looks broken
--     next to the real logos of Pirelli/Continental/Hankook
--
-- What we KEEP (whitelist):
--   • Anything on upload.wikimedia.org — stable Wikipedia Commons URLs
--   • Anything on binaries.pirelli.com / continental.com / hankook — the
--     three brands the user curated manually
--   • Anything on aplustyres.eu — real brand-hosted logo
--
-- Hero images (picsum.photos) are untouched — those actually load.
--
-- Honest answer for future-me: populating 37 high-quality tire-brand
-- logos programmatically needs a paid service (Logo.dev, Brandfetch,
-- Clearbit Enterprise). The free favicon / domain-guess approaches all
-- end up fuzzy or missing for most brands. The admin /brand-info edit
-- panel supports per-brand logo upload — use that for the 10-20 brands
-- that actually matter for marketplace UX.
-- =============================================================================

BEGIN;

UPDATE brand_info
SET "logoUrl" = NULL,
    "updatedAt" = NOW()
WHERE "logoUrl" IS NOT NULL
  AND "logoUrl" NOT LIKE 'https://upload.wikimedia.org/%'
  AND "logoUrl" NOT LIKE 'https://binaries.pirelli.com/%'
  AND "logoUrl" NOT LIKE 'https://aplustyres.eu/%'
  AND "logoUrl" NOT LIKE '%encrypted-tbn%'    -- keep the manual Hankook one
  AND slug NOT IN ('pirelli', 'continental', 'hankook');

COMMIT;
