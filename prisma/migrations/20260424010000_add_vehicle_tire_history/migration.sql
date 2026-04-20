-- =============================================================================
-- VehicleTireHistory — per (vehicle, position, tire) log with mount/desmonte
-- timestamps and performance snapshot at desmonte. Drives the future
-- recommendation engine ("this vehicle's position 1 typically runs
-- Continental HDR2 with avg CPK 48 across 3 replacements").
-- =============================================================================

CREATE TABLE "vehicle_tire_history" (
  "id"                      TEXT NOT NULL,
  "vehicleId"               TEXT NOT NULL,
  "companyId"               TEXT NOT NULL,
  "position"                INTEGER NOT NULL,

  "tireId"                  TEXT,
  "marca"                   TEXT NOT NULL,
  "diseno"                  TEXT NOT NULL,
  "dimension"               TEXT NOT NULL,
  "vidaAlMontaje"           "VidaValue" NOT NULL DEFAULT 'nueva',

  "fechaMontaje"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "fechaDesmonte"           TIMESTAMP(3),
  "motivoDesmonte"          TEXT,

  "kmRecorridosAlDesmonte"  INTEGER,
  "cpkFinal"                DOUBLE PRECISION,
  "profundidadInicial"      DOUBLE PRECISION,
  "profundidadFinalMin"     DOUBLE PRECISION,

  "notas"                   TEXT,

  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"               TIMESTAMP(3) NOT NULL,

  CONSTRAINT "vehicle_tire_history_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "vehicle_tire_history_vehicleId_position_idx"      ON "vehicle_tire_history"("vehicleId", "position");
CREATE INDEX "vehicle_tire_history_vehicleId_fechaDesmonte_idx" ON "vehicle_tire_history"("vehicleId", "fechaDesmonte");
CREATE INDEX "vehicle_tire_history_companyId_idx"               ON "vehicle_tire_history"("companyId");
CREATE INDEX "vehicle_tire_history_tireId_idx"                  ON "vehicle_tire_history"("tireId");
CREATE INDEX "vehicle_tire_history_marca_diseno_dimension_idx"  ON "vehicle_tire_history"("marca", "diseno", "dimension");

ALTER TABLE "vehicle_tire_history"
  ADD CONSTRAINT "vehicle_tire_history_vehicleId_fkey"
  FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "vehicle_tire_history"
  ADD CONSTRAINT "vehicle_tire_history_tireId_fkey"
  FOREIGN KEY ("tireId") REFERENCES "Tire"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "vehicle_tire_history"
  ADD CONSTRAINT "vehicle_tire_history_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
