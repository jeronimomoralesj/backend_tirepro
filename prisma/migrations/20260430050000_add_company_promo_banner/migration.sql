-- Distributor-controlled promotional banner on the public storefront.
-- Surfaced on /marketplace/distributor/<slug>, edited from the perfil
-- page. All four columns nullable so a distributor can clear the
-- banner (or skip it altogether) without affecting anything else.
ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "promoBannerImage" TEXT;
ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "promoBannerTitle" TEXT;
ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "promoBannerSubtitle" TEXT;
ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "promoBannerHref" TEXT;
