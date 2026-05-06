-- Retailer-scraped product specs cached on the catalog SKU. Populated
-- by retail-source.service.ts every time a connected Alkosto / Ktronix
-- listing is refreshed — the scraper extracts the page's
-- "Especificaciones" tables (Características Técnicas / Físicas /
-- Información Adicional / Otros Atributos) and writes the structured
-- JSON here. The product page renders it as a "Detalles de la llanta"
-- block. Multiple distributors may sell the same SKU; whichever
-- refresh runs last wins.
ALTER TABLE "tire_master_catalog"
  ADD COLUMN IF NOT EXISTS "productSpecs"   JSONB,
  ADD COLUMN IF NOT EXISTS "productSpecsAt" TIMESTAMP(3);
