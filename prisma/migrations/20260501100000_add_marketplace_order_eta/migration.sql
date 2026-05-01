-- Distributor-promised delivery date for marketplace orders. Set when
-- the dist confirms the order ("Confirmado") and revisable on later
-- status updates. Powers the ETA callout on the buyer's tracking page
-- and the small "Entrega ~ DD MMM" line on the dist's pedidos cards.
ALTER TABLE "marketplace_orders" ADD COLUMN IF NOT EXISTS "etaDate" TIMESTAMP(3);
