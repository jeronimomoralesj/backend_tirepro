-- =============================================================================
-- Backfill VehicleTireHistory so the new per-position log has useful data
-- from day one, before any new lifecycle events fill it in naturally.
--
-- Two passes:
--
-- 1) OPEN entries for every tire currently mounted on a vehicle.
--    Uses fechaMontaje = the latest TireEvento of type 'montaje' for that
--    tire if available, else tire.createdAt. No fechaDesmonte/motivo set.
--
-- 2) CLOSED entries for every tire with vidaActual='fin' that has a
--    lastVehicleId + lastPosicion snapshot (so we know where it last ran).
--    Uses fechaDesmonte = updatedAt, motivo='fin'. Final stats pulled from
--    the tire's last inspection + tire-level kilometrosRecorridos.
--
-- Idempotent: INSERT ON CONFLICT DO NOTHING guards against double-runs
-- via the natural dedup of (tireId, vehicleId, position, fechaMontaje).
-- Re-running is safe.
--
-- Usage:
--   psql "$DATABASE_URL" -f scripts/backfill-vehicle-tire-history.sql
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1) OPEN entries — currently-mounted tires
-- -----------------------------------------------------------------------------
INSERT INTO vehicle_tire_history (
  id, "vehicleId", "companyId", position,
  "tireId", marca, diseno, dimension, "vidaAlMontaje",
  "profundidadInicial",
  "fechaMontaje",
  "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(),
  t."vehicleId",
  t."companyId",
  COALESCE(t.posicion, 0),
  t.id,
  t.marca,
  t.diseno,
  t.dimension,
  COALESCE(t."vidaActual", 'nueva'),
  t."profundidadInicial",
  -- Earliest montaje event that matches the current vida, if any; fall
  -- back to tire.createdAt when no matching event exists.
  COALESCE(
    (
      SELECT MAX(e.fecha)
      FROM tire_eventos e
      WHERE e."tireId" = t.id
        AND e.tipo = 'montaje'
        AND (e.notas IS NULL OR LOWER(e.notas) = LOWER(t."vidaActual"::text))
    ),
    t."createdAt"
  ),
  NOW(),
  NOW()
FROM "Tire" t
WHERE t."vehicleId" IS NOT NULL
  AND t.posicion IS NOT NULL
  AND t.posicion > 0
  AND t."vidaActual" <> 'fin'
  AND t.marca IS NOT NULL    AND TRIM(t.marca) <> ''
  AND t.diseno IS NOT NULL   AND TRIM(t.diseno) <> ''
  AND t.dimension IS NOT NULL AND TRIM(t.dimension) <> ''
  -- Avoid duplicating on re-run
  AND NOT EXISTS (
    SELECT 1 FROM vehicle_tire_history h
    WHERE h."tireId" = t.id
      AND h."fechaDesmonte" IS NULL
  );

-- -----------------------------------------------------------------------------
-- 2) CLOSED entries — retired tires that still remember where they ran
--    (lastVehicleId + lastPosicion populated by the desecho flow).
-- -----------------------------------------------------------------------------
INSERT INTO vehicle_tire_history (
  id, "vehicleId", "companyId", position,
  "tireId", marca, diseno, dimension, "vidaAlMontaje",
  "profundidadInicial",
  "fechaMontaje", "fechaDesmonte", "motivoDesmonte",
  "kmRecorridosAlDesmonte", "cpkFinal", "profundidadFinalMin",
  "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(),
  t."lastVehicleId",
  t."companyId",
  COALESCE(t."lastPosicion", 0),
  t.id,
  t.marca, t.diseno, t.dimension,
  'nueva'::"VidaValue",              -- best guess; we don't have the vida-at-mount
  t."profundidadInicial",
  -- Best approximations for mount / desmonte times:
  COALESCE(
    (SELECT MIN(e.fecha) FROM tire_eventos e WHERE e."tireId" = t.id AND e.tipo = 'montaje'),
    t."createdAt"
  ) AS fm,
  COALESCE(t."updatedAt", NOW()) AS fd,
  'fin',
  t."kilometrosRecorridos",
  COALESCE(t."lifetimeCpk", t."currentCpk"),
  -- Min depth from the latest inspection, if any.
  (
    SELECT LEAST(i."profundidadInt", i."profundidadCen", i."profundidadExt")
    FROM inspecciones i
    WHERE i."tireId" = t.id
    ORDER BY i.fecha DESC
    LIMIT 1
  ),
  NOW(),
  NOW()
FROM "Tire" t
WHERE t."vidaActual" = 'fin'
  AND t."lastVehicleId" IS NOT NULL
  AND t.marca IS NOT NULL    AND TRIM(t.marca) <> ''
  AND t.diseno IS NOT NULL   AND TRIM(t.diseno) <> ''
  AND t.dimension IS NOT NULL AND TRIM(t.dimension) <> ''
  -- Confirm the recorded lastVehicleId still exists — avoid orphan FK errors.
  AND EXISTS (SELECT 1 FROM "Vehicle" v WHERE v.id = t."lastVehicleId")
  AND NOT EXISTS (
    SELECT 1 FROM vehicle_tire_history h
    WHERE h."tireId" = t.id
      AND h."motivoDesmonte" = 'fin'
  );

COMMIT;
