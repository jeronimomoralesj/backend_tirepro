-- Marker for desmounts where the technician didn't capture the vehicle's
-- km at the moment the tire came off. The /dashboard/inventario UI reads
-- this to surface a "Datos faltantes" badge so the data can be filled in
-- after the fact (cleared on fill-in).
ALTER TABLE "Tire"
  ADD COLUMN "desmountDataPending" BOOLEAN NOT NULL DEFAULT false;

-- Partial index — we only ever query "give me the flagged tires", which
-- is a small subset of the table. A full index would waste space on the
-- much larger "no missing data" majority.
CREATE INDEX "Tire_desmountDataPending_idx"
  ON "Tire" ("companyId", "desmountDataPending")
  WHERE "desmountDataPending" = true;
