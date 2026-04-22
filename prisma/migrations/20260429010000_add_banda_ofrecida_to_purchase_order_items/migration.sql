-- =============================================================================
-- Distributors quote a reencauche with both a banda brand and a banda model
-- — not a single free-text string. Two nullable columns capture the offer
-- at cotización time; they stay NULL for llanta-nueva items.
-- =============================================================================

ALTER TABLE "purchase_order_items"
  ADD COLUMN "bandaOfrecidaMarca"  TEXT,
  ADD COLUMN "bandaOfrecidaModelo" TEXT;
