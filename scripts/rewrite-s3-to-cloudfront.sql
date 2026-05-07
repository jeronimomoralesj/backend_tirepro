-- =============================================================================
-- One-shot host-rewrite: tireproimages.s3.us-east-1.amazonaws.com → CloudFront
--
-- Run AFTER `S3Service.publicUrl()` has been deployed and CDN_BASE_URL is
-- set on the EC2 .env. Sweeps every existing image URL in the DB and
-- rewrites the host so historical listings, profile pics, brand logos,
-- etc. start serving from the CloudFront edge instead of direct S3.
--
-- IDEMPOTENT: re-running has no effect because each WHERE clause
-- filters to rows whose URL still has the old S3 host.
--
-- DEFENSIVE: every UPDATE is wrapped in a PL/pgSQL EXCEPTION handler.
-- If a column declared in schema.prisma was never actually shipped to
-- the prod DB (drift), that one block prints "skipped" and the rest
-- of the migration continues. We saw this on Tire.imageUrl /
-- Tire.imageUrls in May 2026.
--
-- HOW TO RUN (from the EC2 instance):
--
--   psql "${DATABASE_URL%%\?*}" -f ~/backend_tirepro/scripts/rewrite-s3-to-cloudfront.sql
--
-- The %%\?* strips the Prisma `?schema=public` query parameter that
-- native psql doesn't understand.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  old_host TEXT := 'https://tireproimages.s3.us-east-1.amazonaws.com/';
  new_host TEXT := 'https://d20e2qoyytdvc3.cloudfront.net/';
  rc INT;
BEGIN

  -- ── Company.profileImage ─────────────────────────────────────────────
  BEGIN
    UPDATE "Company"
       SET "profileImage" = REPLACE("profileImage", old_host, new_host)
     WHERE "profileImage" LIKE old_host || '%';
    GET DIAGNOSTICS rc = ROW_COUNT;
    RAISE NOTICE 'Company.profileImage:        % rows', rc;
  EXCEPTION WHEN undefined_column OR undefined_table THEN
    RAISE NOTICE 'Company.profileImage:        skipped (missing in DB)';
  END;

  BEGIN
    UPDATE "Company"
       SET "bannerImage" = REPLACE("bannerImage", old_host, new_host)
     WHERE "bannerImage" LIKE old_host || '%';
    GET DIAGNOSTICS rc = ROW_COUNT;
    RAISE NOTICE 'Company.bannerImage:         % rows', rc;
  EXCEPTION WHEN undefined_column OR undefined_table THEN
    RAISE NOTICE 'Company.bannerImage:         skipped (missing in DB)';
  END;

  BEGIN
    UPDATE "Company"
       SET "promoBannerImage" = REPLACE("promoBannerImage", old_host, new_host)
     WHERE "promoBannerImage" LIKE old_host || '%';
    GET DIAGNOSTICS rc = ROW_COUNT;
    RAISE NOTICE 'Company.promoBannerImage:    % rows', rc;
  EXCEPTION WHEN undefined_column OR undefined_table THEN
    RAISE NOTICE 'Company.promoBannerImage:    skipped (missing in DB)';
  END;

  -- ── Tire.imageUrl (legacy single-image, may not exist in prod) ───────
  BEGIN
    UPDATE "Tire"
       SET "imageUrl" = REPLACE("imageUrl", old_host, new_host)
     WHERE "imageUrl" LIKE old_host || '%';
    GET DIAGNOSTICS rc = ROW_COUNT;
    RAISE NOTICE 'Tire.imageUrl:               % rows', rc;
  EXCEPTION WHEN undefined_column OR undefined_table THEN
    RAISE NOTICE 'Tire.imageUrl:               skipped (missing in DB)';
  END;

  -- ── Tire.imageUrls (TEXT[], may not exist in prod) ───────────────────
  BEGIN
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
  EXCEPTION WHEN undefined_column OR undefined_table THEN
    RAISE NOTICE 'Tire.imageUrls:              skipped (missing in DB)';
  END;

  -- ── Tire.desechoImageUrls (TEXT[], may not exist in prod) ────────────
  BEGIN
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
  EXCEPTION WHEN undefined_column OR undefined_table THEN
    RAISE NOTICE 'Tire.desechoImageUrls:       skipped (missing in DB)';
  END;

  -- ── BlogPost.coverImage (table is `articles`) ────────────────────────
  BEGIN
    UPDATE articles
       SET "coverImage" = REPLACE("coverImage", old_host, new_host)
     WHERE "coverImage" LIKE old_host || '%';
    GET DIAGNOSTICS rc = ROW_COUNT;
    RAISE NOTICE 'articles.coverImage:         % rows', rc;
  EXCEPTION WHEN undefined_column OR undefined_table THEN
    RAISE NOTICE 'articles.coverImage:         skipped (missing in DB)';
  END;

  -- ── BrandInfo (table `brand_info`) ───────────────────────────────────
  BEGIN
    UPDATE brand_info
       SET "logoUrl" = REPLACE("logoUrl", old_host, new_host)
     WHERE "logoUrl" LIKE old_host || '%';
    GET DIAGNOSTICS rc = ROW_COUNT;
    RAISE NOTICE 'brand_info.logoUrl:          % rows', rc;
  EXCEPTION WHEN undefined_column OR undefined_table THEN
    RAISE NOTICE 'brand_info.logoUrl:          skipped (missing in DB)';
  END;

  BEGIN
    UPDATE brand_info
       SET "heroImageUrl" = REPLACE("heroImageUrl", old_host, new_host)
     WHERE "heroImageUrl" LIKE old_host || '%';
    GET DIAGNOSTICS rc = ROW_COUNT;
    RAISE NOTICE 'brand_info.heroImageUrl:     % rows', rc;
  EXCEPTION WHEN undefined_column OR undefined_table THEN
    RAISE NOTICE 'brand_info.heroImageUrl:     skipped (missing in DB)';
  END;

  BEGIN
    UPDATE brand_info
       SET "videoUrl" = REPLACE("videoUrl", old_host, new_host)
     WHERE "videoUrl" LIKE old_host || '%';
    GET DIAGNOSTICS rc = ROW_COUNT;
    RAISE NOTICE 'brand_info.videoUrl:         % rows', rc;
  EXCEPTION WHEN undefined_column OR undefined_table THEN
    RAISE NOTICE 'brand_info.videoUrl:         skipped (missing in DB)';
  END;

  -- ── CatalogImage.url (table `catalog_images`) ────────────────────────
  BEGIN
    UPDATE catalog_images
       SET "url" = REPLACE("url", old_host, new_host)
     WHERE "url" LIKE old_host || '%';
    GET DIAGNOSTICS rc = ROW_COUNT;
    RAISE NOTICE 'catalog_images.url:          % rows', rc;
  EXCEPTION WHEN undefined_column OR undefined_table THEN
    RAISE NOTICE 'catalog_images.url:          skipped (missing in DB)';
  END;

  -- ── CatalogVideo.url (table `catalog_videos`) ────────────────────────
  BEGIN
    UPDATE catalog_videos
       SET "url" = REPLACE("url", old_host, new_host)
     WHERE "url" LIKE old_host || '%';
    GET DIAGNOSTICS rc = ROW_COUNT;
    RAISE NOTICE 'catalog_videos.url:          % rows', rc;
  EXCEPTION WHEN undefined_column OR undefined_table THEN
    RAISE NOTICE 'catalog_videos.url:          skipped (missing in DB)';
  END;

  -- ── DistributorListing.imageUrls (jsonb array of strings) ────────────
  BEGIN
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
  EXCEPTION WHEN undefined_column OR undefined_table THEN
    RAISE NOTICE 'distributor_listings.imageUrls: skipped (missing in DB)';
  END;

END $$;

COMMIT;

-- Quick verification: how many rows still reference the old S3 host on
-- the columns we know exist (Company + DistributorListing — the two
-- sources of marketplace-visible images that we've confirmed live in
-- prod). Anything else is best-effort and shows up in the RAISE NOTICE
-- output above.
SELECT 'Company.profileImage'              AS col, COUNT(*) AS remaining
  FROM "Company" WHERE "profileImage"     LIKE 'https://tireproimages.s3.us-east-1.amazonaws.com/%'
UNION ALL
SELECT 'Company.bannerImage',                       COUNT(*)
  FROM "Company" WHERE "bannerImage"      LIKE 'https://tireproimages.s3.us-east-1.amazonaws.com/%'
UNION ALL
SELECT 'Company.promoBannerImage',                  COUNT(*)
  FROM "Company" WHERE "promoBannerImage" LIKE 'https://tireproimages.s3.us-east-1.amazonaws.com/%'
UNION ALL
SELECT 'distributor_listings.imageUrls',            COUNT(*)
  FROM distributor_listings
 WHERE "imageUrls" IS NOT NULL
   AND "imageUrls"::text LIKE '%tireproimages.s3.us-east-1.amazonaws.com%';
