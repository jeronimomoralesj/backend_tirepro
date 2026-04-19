-- =============================================================================
-- One-shot cleanup: archive vehicles with no inspection in ≥ 1 year and
-- retire tires that are both worn (≤ 3 mm) and un-inspected for ≥ 6 months.
--
-- Neither operation deletes anything. The vehicle keeps all its rows and
-- can be un-archived later by setting archivedAt=NULL. Tires get
-- vidaActual='fin' + a TireEvento entry so the audit trail explains why.
--
-- Thresholds (re-run after the merquellantas migration):
--   • Vehicle stale: max(inspection.fecha on ANY tire) < NOW() - 1 year
--   • Tire stale:    last inspection > 6 months ago AND min depth ≤ 3 mm
--
-- Usage:
--   psql "$DATABASE_URL" -f scripts/archive-stale-vehicles-and-tires.sql
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1) Archive stale tires — profundidad mín ≤ 3 mm AND last inspection ≥ 6 months
-- -----------------------------------------------------------------------------
-- Resolve the latest inspection per tire, then compute min depth + fecha.
WITH last_insp_per_tire AS (
  SELECT DISTINCT ON ("tireId")
    "tireId",
    fecha,
    "profundidadInt",
    "profundidadCen",
    "profundidadExt"
  FROM inspecciones
  ORDER BY "tireId", fecha DESC
),
stale_tires AS (
  SELECT
    t.id               AS tire_id,
    t."companyId"      AS company_id,
    li.fecha           AS last_fecha,
    LEAST(li."profundidadInt", li."profundidadCen", li."profundidadExt") AS min_depth
  FROM "Tire" t
  JOIN last_insp_per_tire li ON li."tireId" = t.id
  WHERE t."vidaActual" <> 'fin'
    AND li.fecha < NOW() - INTERVAL '6 months'
    AND LEAST(li."profundidadInt", li."profundidadCen", li."profundidadExt") <= 3
)
UPDATE "Tire" t
SET "vidaActual" = 'fin',
    "updatedAt"  = NOW()
FROM stale_tires s
WHERE t.id = s.tire_id;

-- Record a TireEvento so the dashboard's vida timeline explains the retirement.
INSERT INTO tire_eventos (id, "tireId", tipo, fecha, notas, "createdAt")
SELECT
  gen_random_uuid(),
  t.id,
  'montaje',
  NOW(),
  'fin',
  NOW()
FROM "Tire" t
WHERE t."vidaActual" = 'fin'
  AND NOT EXISTS (
    -- Don't double-record if the tire already has a 'fin' event
    SELECT 1
    FROM tire_eventos e
    WHERE e."tireId" = t.id
      AND e.tipo = 'montaje'
      AND e.notas = 'fin'
  );

-- -----------------------------------------------------------------------------
-- 2) Archive stale vehicles — no inspection on any tire for ≥ 1 year
-- -----------------------------------------------------------------------------
-- A vehicle counts as stale if the most-recent inspection across all of
-- its currently-mounted tires is older than 1 year. Vehicles whose tires
-- were just archived above still count — we use the inspection history,
-- not the current tire state.
WITH vehicle_last_insp AS (
  SELECT
    v.id                    AS vehicle_id,
    v."companyId"           AS company_id,
    MAX(i.fecha)            AS last_inspection
  FROM "Vehicle" v
  LEFT JOIN "Tire"          t ON t."vehicleId" = v.id
  LEFT JOIN inspecciones    i ON i."tireId"    = t.id
  WHERE v."archivedAt" IS NULL
  GROUP BY v.id, v."companyId"
)
UPDATE "Vehicle" v
SET "archivedAt" = NOW(),
    "updatedAt"  = NOW()
FROM vehicle_last_insp vli
WHERE v.id = vli.vehicle_id
  AND (
    -- Either no inspection at all OR the last one is > 1 year old.
    vli.last_inspection IS NULL
    OR vli.last_inspection < NOW() - INTERVAL '1 year'
  );

COMMIT;
