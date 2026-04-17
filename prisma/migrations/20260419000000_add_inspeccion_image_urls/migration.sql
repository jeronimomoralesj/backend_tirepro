-- Inspecciones now support up to 2 photos per tire. Existing imageUrl is
-- preserved for legacy reads; new writes populate imageUrls.
ALTER TABLE "inspecciones"
  ADD COLUMN IF NOT EXISTS "imageUrls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Backfill: copy imageUrl into imageUrls for rows that already have one
-- photo so the new UI sees both fields in sync.
UPDATE "inspecciones"
SET "imageUrls" = ARRAY["imageUrl"]
WHERE "imageUrl" IS NOT NULL
  AND cardinality("imageUrls") = 0;
