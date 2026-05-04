-- Loop video URL for the brand hero (admin-editable).
ALTER TABLE "brand_info"
  ADD COLUMN IF NOT EXISTS "videoUrl" TEXT;
