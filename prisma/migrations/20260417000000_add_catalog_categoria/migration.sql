-- Adds a categoria column to the master catalog so admins can label each SKU
-- as "nueva" (new tire) or "reencauche" (retread band), matching how the
-- product actually ships.
ALTER TABLE "tire_master_catalog"
  ADD COLUMN IF NOT EXISTS "categoria" TEXT;

CREATE INDEX IF NOT EXISTS "tire_master_catalog_categoria_idx"
  ON "tire_master_catalog" ("categoria");
