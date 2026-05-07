-- =============================================================================
-- One-shot host-rewrite: tireproimages.s3.us-east-1.amazonaws.com → CloudFront
--
-- Run AFTER `S3Service.publicUrl()` has been deployed and CDN_BASE_URL is
-- set on the EC2 .env. This sweeps every existing image URL in the DB
-- and rewrites the host so historical listings, profile pics, brand
-- logos, etc. start serving from the CloudFront edge instead of direct
-- S3 us-east-1.
--
-- IDEMPOTENT: re-running has no effect because each WHERE clause filters
-- to rows whose URL still has the old S3 host. Once rewritten, the row
-- no longer matches.
--
-- ROLLBACK: every UPDATE runs in a single transaction. If anything
-- fails, the whole script rolls back. To revert AFTER commit, swap the
-- find/replace direction in this file and re-run.
--
-- HOW TO RUN (from the EC2 instance):
--
--   psql "$DATABASE_URL" -f ~/backend_tirepro/scripts/rewrite-s3-to-cloudfront.sql
--
-- The RAISE NOTICE lines print row counts per table so you can sanity-
-- check the migration end-to-end.
-- =============================================================================

\set OLD_HOST 'https://tireproimages.s3.us-east-1.amazonaws.com/'
\set NEW_HOST 'https://d20e2qoyytdvc3.cloudfront.net/'

BEGIN;

DO $$
DECLARE
  old_host TEXT := 'https://tireproimages.s3.us-east-1.amazonaws.com/';
  new_host TEXT := 'https://d20e2qoyytdvc3.cloudfront.net/';
  rc INT;
BEGIN

  -- ── Company.profileImage / bannerImage / promoBannerImage ────────────
  UPDATE "Company"
     SET "profileImage" = REPLACE("profileImage", old_host, new_host)
   WHERE "profileImage" LIKE old_host || '%';
  GET DIAGNOSTICS rc = ROW_COUNT;
  RAISE NOTICE 'Company.profileImage:        % rows', rc;

  UPDATE "Company"
     SET "bannerImage" = REPLACE("bannerImage", old_host, new_host)
   WHERE "bannerImage" LIKE old_host || '%';
  GET DIAGNOSTICS rc = ROW_COUNT;
  RAISE NOTICE 'Company.bannerImage:         % rows', rc;

  UPDATE "Company"
     SET "promoBannerImage" = REPLACE("promoBannerImage", old_host, new_host)
   WHERE "promoBannerImage" LIKE old_host || '%';
  GET DIAGNOSTICS rc = ROW_COUNT;
  RAISE NOTICE 'Company.promoBannerImage:    % rows', rc;

  -- ── Tire.imageUrl (legacy single-image field, may not exist) ─────────
  -- Schema declares this column for backward compat with older rows but
  -- it was never present in the prod DB (drift between schema.prisma
  -- and the live migration history). Wrapped in EXCEPTION so the
  -- migration doesn't blow up if the column is genuinely absent.
  BEGIN
    UPDATE "Tire"
       SET "imageUrl" = REPLACE("imageUrl", old_host, new_host)
     WHERE "imageUrl" LIKE old_host || '%';
    GET DIAGNOSTICS rc = ROW_COUNT;
    RAISE NOTICE 'Tire.imageUrl:               % rows', rc;
  EXCEPTION
    WHEN undefined_column THEN
      RAISE NOTICE 'Tire.imageUrl:               skipped (column missing in DB)';
  END;

  -- ── Tire.imageUrls (Postgres TEXT[]) ─────────────────────────────────
  UPDATE "Tire"
     SET "imageUrls" = ARRAY(
       SELECT REPLACE(u, old_host, new_host)
         FROM unnest("imageUrls") AS u
     )
   WHERE EXISTS (
     SELECT 1 FROM unnest("imageUrls") AS u
      WHERE u LIKE old_host || '%'
   );
  GET DIAGNOSTICS rc = ROW_COUNT;
  RAISE NOTICE 'Tire.imageUrls:              % rows', rc;

  -- ── Tire.desechoImageUrls (Postgres TEXT[]) ──────────────────────────
  UPDATE "Tire"
     SET "desechoImageUrls" = ARRAY(
       SELECT REPLACE(u, old_host, new_host)
         FROM unnest("desechoImageUrls") AS u
     )
   WHERE EXISTS (
     SELECT 1 FROM unnest("desechoImageUrls") AS u
      WHERE u LIKE old_host || '%'
   );
  GET DIAGNOSTICS rc = ROW_COUNT;
  RAISE NOTICE 'Tire.desechoImageUrls:       % rows', rc;

  -- ── BlogPost.coverImage (table is `articles` per @@map) ───────────────
  UPDATE articles
     SET "coverImage" = REPLACE("coverImage", old_host, new_host)
   WHERE "coverImage" LIKE old_host || '%';
  GET DIAGNOSTICS rc = ROW_COUNT;
  RAISE NOTICE 'articles.coverImage:         % rows', rc;

  -- ── BrandInfo.logoUrl / heroImageUrl / videoUrl (table `brand_info`) ──
  UPDATE brand_info
     SET "logoUrl" = REPLACE("logoUrl", old_host, new_host)
   WHERE "logoUrl" LIKE old_host || '%';
  GET DIAGNOSTICS rc = ROW_COUNT;
  RAISE NOTICE 'brand_info.logoUrl:          % rows', rc;

  UPDATE brand_info
     SET "heroImageUrl" = REPLACE("heroImageUrl", old_host, new_host)
   WHERE "heroImageUrl" LIKE old_host || '%';
  GET DIAGNOSTICS rc = ROW_COUNT;
  RAISE NOTICE 'brand_info.heroImageUrl:     % rows', rc;

  UPDATE brand_info
     SET "videoUrl" = REPLACE("videoUrl", old_host, new_host)
   WHERE "videoUrl" LIKE old_host || '%';
  GET DIAGNOSTICS rc = ROW_COUNT;
  RAISE NOTICE 'brand_info.videoUrl:         % rows', rc;

  -- ── CatalogImage.url (table `catalog_images`) ────────────────────────
  UPDATE catalog_images
     SET "url" = REPLACE("url", old_host, new_host)
   WHERE "url" LIKE old_host || '%';
  GET DIAGNOSTICS rc = ROW_COUNT;
  RAISE NOTICE 'catalog_images.url:          % rows', rc;

  -- ── CatalogVideo.url (table `catalog_videos`) ────────────────────────
  UPDATE catalog_videos
     SET "url" = REPLACE("url", old_host, new_host)
   WHERE "url" LIKE old_host || '%';
  GET DIAGNOSTICS rc = ROW_COUNT;
  RAISE NOTICE 'catalog_videos.url:          % rows', rc;

  -- ── DistributorListing.imageUrls (Json/jsonb array of strings) ───────
  -- jsonb path: rebuild the array, replacing each string element. Skips
  -- non-string elements defensively so a malformed row doesn't crash
  -- the whole rewrite.
  UPDATE distributor_listings
     SET "imageUrls" = (
       SELECT jsonb_agg(
         CASE
           WHEN jsonb_typeof(elem) = 'string'
                AND (elem #>> '{}') LIKE old_host || '%'
           THEN to_jsonb(REPLACE(elem #>> '{}', old_host, new_host))
           ELSE elem
         END
       )
         FROM jsonb_array_elements("imageUrls") AS elem
     )
   WHERE "imageUrls" IS NOT NULL
     AND jsonb_typeof("imageUrls") = 'array'
     AND "imageUrls"::text LIKE '%tireproimages.s3.us-east-1.amazonaws.com%';
  GET DIAGNOSTICS rc = ROW_COUNT;
  RAISE NOTICE 'distributor_listings.imageUrls: % rows', rc;

END $$;

COMMIT;

-- Verify zero remaining S3 references in the rewritten columns.
-- Should print 0 across the board after a successful run.
SELECT 'Company.profileImage'        AS col, COUNT(*) AS remaining FROM "Company"        WHERE "profileImage"     LIKE 'https://tireproimages.s3.us-east-1.amazonaws.com/%'
UNION ALL
SELECT 'Company.bannerImage',                COUNT(*)             FROM "Company"        WHERE "bannerImage"      LIKE 'https://tireproimages.s3.us-east-1.amazonaws.com/%'
UNION ALL
SELECT 'Company.promoBannerImage',           COUNT(*)             FROM "Company"        WHERE "promoBannerImage" LIKE 'https://tireproimages.s3.us-east-1.amazonaws.com/%'
UNION ALL
SELECT 'Tire.imageUrls',                      COUNT(*)             FROM "Tire"           WHERE EXISTS (SELECT 1 FROM unnest("imageUrls") AS u WHERE u LIKE 'https://tireproimages.s3.us-east-1.amazonaws.com/%')
UNION ALL
SELECT 'Tire.desechoImageUrls',               COUNT(*)             FROM "Tire"           WHERE EXISTS (SELECT 1 FROM unnest("desechoImageUrls") AS u WHERE u LIKE 'https://tireproimages.s3.us-east-1.amazonaws.com/%')
UNION ALL
SELECT 'articles.coverImage',                 COUNT(*)             FROM articles         WHERE "coverImage"       LIKE 'https://tireproimages.s3.us-east-1.amazonaws.com/%'
UNION ALL
SELECT 'brand_info.logoUrl',                  COUNT(*)             FROM brand_info       WHERE "logoUrl"          LIKE 'https://tireproimages.s3.us-east-1.amazonaws.com/%'
UNION ALL
SELECT 'brand_info.heroImageUrl',             COUNT(*)             FROM brand_info       WHERE "heroImageUrl"     LIKE 'https://tireproimages.s3.us-east-1.amazonaws.com/%'
UNION ALL
SELECT 'brand_info.videoUrl',                 COUNT(*)             FROM brand_info       WHERE "videoUrl"         LIKE 'https://tireproimages.s3.us-east-1.amazonaws.com/%'
UNION ALL
SELECT 'catalog_images.url',                  COUNT(*)             FROM catalog_images   WHERE "url"              LIKE 'https://tireproimages.s3.us-east-1.amazonaws.com/%'
UNION ALL
SELECT 'catalog_videos.url',                  COUNT(*)             FROM catalog_videos   WHERE "url"              LIKE 'https://tireproimages.s3.us-east-1.amazonaws.com/%'
UNION ALL
SELECT 'distributor_listings.imageUrls',      COUNT(*)             FROM distributor_listings WHERE "imageUrls" IS NOT NULL AND "imageUrls"::text LIKE '%tireproimages.s3.us-east-1.amazonaws.com%';
