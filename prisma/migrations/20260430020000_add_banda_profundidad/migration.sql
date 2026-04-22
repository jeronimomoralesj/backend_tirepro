-- =============================================================================
-- Quote-time profundidad — the banda's initial thickness in mm. Captured at
-- cotización time (dist quote or bid response) so the EntregarModal seeds
-- the tire vida snapshot with the exact value the dist committed to,
-- instead of a hardcoded default. Null on llanta-nueva items.
-- =============================================================================

ALTER TABLE "purchase_order_items"
  ADD COLUMN "bandaOfrecidaProfundidad" DOUBLE PRECISION;
