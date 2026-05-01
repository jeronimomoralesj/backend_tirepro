-- Audit log of status changes per marketplace order. Stored as a JSONB
-- array of {status, at, note?} entries — append-only, written once on
-- creation and again on every PATCH /orders/:id/status. The buyer's
-- tracking page renders this as a step-by-step journey timeline.
ALTER TABLE "marketplace_orders" ADD COLUMN IF NOT EXISTS "statusHistory" JSONB;
