-- =============================================================================
-- The dist's reject step now branches: the tire either goes to fin-de-vida
-- (existing `rechazada`) OR is returned to the fleet's Disponible bucket
-- because it's still usable just not retreadable for this job. The new
-- enum value captures that second path so analytics can distinguish
-- "couldn't retread but reusable" from "scrapped".
-- =============================================================================

ALTER TYPE "PurchaseOrderItemStatus" ADD VALUE IF NOT EXISTS 'devuelta';
