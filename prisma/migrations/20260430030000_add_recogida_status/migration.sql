-- =============================================================================
-- Two-phase pickup: dist first confirms which tires they physically collected
-- (recogida_por_dist), then separately decides per-tire what happens to each
-- (reencauchar / devolver / fin de vida). A tire that wasn't at the facility
-- on pickup day stays in `cotizada` so the dist can come back for it later.
-- =============================================================================

ALTER TYPE "PurchaseOrderItemStatus" ADD VALUE IF NOT EXISTS 'recogida_por_dist';
