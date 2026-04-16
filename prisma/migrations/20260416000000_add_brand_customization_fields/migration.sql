-- Admin-editable brand page customization fields
ALTER TABLE "brand_info"
  ADD COLUMN IF NOT EXISTS "primaryColor" TEXT,
  ADD COLUMN IF NOT EXISTS "accentColor"  TEXT,
  ADD COLUMN IF NOT EXISTS "heroImageUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "tagline"      TEXT,
  ADD COLUMN IF NOT EXISTS "published"    BOOLEAN NOT NULL DEFAULT TRUE;
