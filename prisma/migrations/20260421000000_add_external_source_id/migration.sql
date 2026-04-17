-- External system dedup keys so integrators (MERQUEPRO et al.) can re-run
-- imports without creating duplicate rows.
ALTER TABLE "Vehicle"     ADD COLUMN IF NOT EXISTS "externalSourceId" TEXT;
ALTER TABLE "Tire"        ADD COLUMN IF NOT EXISTS "externalSourceId" TEXT;
ALTER TABLE "inspecciones" ADD COLUMN IF NOT EXISTS "externalSourceId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Vehicle_externalSourceId_key"      ON "Vehicle"      ("externalSourceId");
CREATE UNIQUE INDEX IF NOT EXISTS "Tire_externalSourceId_key"         ON "Tire"         ("externalSourceId");
CREATE UNIQUE INDEX IF NOT EXISTS "inspecciones_externalSourceId_key" ON "inspecciones" ("externalSourceId");
