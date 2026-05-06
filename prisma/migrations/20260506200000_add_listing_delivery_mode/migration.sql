-- Per-listing delivery mode override. Distributors set this on the
-- "Nuevo producto" / edit-listing form when a specific SKU should
-- behave differently from their company-wide tipoEntrega:
--   "domicilio" — home-delivery only
--   "pickup"    — pickup at retail bodega only
--   "both"      — both options offered to the buyer
-- NULL means "use the distributor's default tipoEntrega" (current
-- behaviour for every existing listing — they all stay null until
-- the distributor explicitly opts in).
ALTER TABLE "distributor_listings"
  ADD COLUMN IF NOT EXISTS "deliveryMode" TEXT;
