-- =============================================================================
-- Add VehicleOperationalState + make Vehicle.companyId / Tire.companyId
-- nullable + add lossless sourceMetadata columns across Vehicle, Tire,
-- Inspeccion.
--
-- Safe to apply on a live DB:
--   • Existing rows are unchanged (defaults fill new cols; FK stays intact
--     while nullable allows future orphan writes).
--   • Relation onDelete changes from CASCADE → SET NULL so deleting a
--     company preserves its vehicles + tires as orphans (intended behavior
--     for historical analysis).
-- =============================================================================

-- 1) Enum --------------------------------------------------------------------
CREATE TYPE "VehicleOperationalState" AS ENUM ('activo', 'fuera_de_operacion');

-- 2) Vehicle -----------------------------------------------------------------
ALTER TABLE "Vehicle"
  ALTER COLUMN "companyId" DROP NOT NULL,
  ADD COLUMN "estadoOperacional"     "VehicleOperationalState" NOT NULL DEFAULT 'activo',
  ADD COLUMN "fueraDeOperacionDesde" TIMESTAMP(3),
  ADD COLUMN "originalClient"        TEXT,
  ADD COLUMN "kmMensualMerquepro"    DOUBLE PRECISION,
  ADD COLUMN "ultimaActividadAt"     TIMESTAMP(3),
  ADD COLUMN "sourceMetadata"        JSONB;

-- Relax FK: deleting a company now orphans its vehicles instead of cascading.
ALTER TABLE "Vehicle" DROP CONSTRAINT "Vehicle_companyId_fkey";
ALTER TABLE "Vehicle"
  ADD CONSTRAINT "Vehicle_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Vehicle_estadoOperacional_idx" ON "Vehicle"("estadoOperacional");

-- 3) Tire --------------------------------------------------------------------
ALTER TABLE "Tire"
  ALTER COLUMN "companyId" DROP NOT NULL,
  ADD COLUMN "originalClient" TEXT,
  ADD COLUMN "sourceMetadata" JSONB;

ALTER TABLE "Tire" DROP CONSTRAINT "Tire_companyId_fkey";
ALTER TABLE "Tire"
  ADD CONSTRAINT "Tire_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 4) Inspeccion --------------------------------------------------------------
ALTER TABLE "inspecciones"
  ADD COLUMN "sourceMetadata" JSONB;

-- 5) TireVidaSnapshot --------------------------------------------------------
ALTER TABLE "tire_vida_snapshots"
  ALTER COLUMN "companyId" DROP NOT NULL;

ALTER TABLE "tire_vida_snapshots" DROP CONSTRAINT "tire_vida_snapshots_companyId_fkey";
ALTER TABLE "tire_vida_snapshots"
  ADD CONSTRAINT "tire_vida_snapshots_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 6) VehicleTireHistory ------------------------------------------------------
-- Allow history rows to survive orphaning: companyId becomes nullable and
-- onDelete switches to SET NULL so deleting a company no longer nukes its
-- history log (needed for long-horizon recommendations).
ALTER TABLE "vehicle_tire_history"
  ALTER COLUMN "companyId" DROP NOT NULL;

ALTER TABLE "vehicle_tire_history" DROP CONSTRAINT "vehicle_tire_history_companyId_fkey";
ALTER TABLE "vehicle_tire_history"
  ADD CONSTRAINT "vehicle_tire_history_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
