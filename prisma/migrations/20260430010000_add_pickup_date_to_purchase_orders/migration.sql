-- =============================================================================
-- Pickup is now an explicit step owned by the distributor. After the fleet
-- accepts the quote, the dist schedules a pickup date; at the pickup moment
-- the dist performs per-tire decisions (reencauchar / devolver / fin de vida)
-- and the tires physically leave the vehicles. One nullable column on
-- purchase_orders is enough — individual items already track their own
-- lifecycle state.
-- =============================================================================

ALTER TABLE "purchase_orders"
  ADD COLUMN "pickupDate" TIMESTAMP(3);
