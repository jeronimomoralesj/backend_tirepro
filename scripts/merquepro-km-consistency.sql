-- =============================================================================
-- Merquepro km-consistency repair (final pass).
--
-- The earlier importer + backfills were confusing three different quantities
-- and overwriting each other:
--
--   • vehicle odometer (kmActualVehiculo on an inspection)
--   • tire km-in-current-life (what Tire.kilometrosRecorridos should be)
--   • Inspeccion.kmEfectivos (km consumed by the tire up to that inspection)
--
-- The importer set kmEfectivos = kmActualVehiculo = the raw vehicle odometer
-- for each inspection row. A later backfill then used MAX(kmEfectivos) as
-- the tire's life km — producing tires that claimed to have done 186,284 km
-- when they really meant "the vehicle they're mounted on is at odometer
-- 186,284."
--
-- This script restores the invariant:
--   km-in-life  =  MAX(odo) − MIN(odo)  across inspections of the CURRENT
--                  vida, after fechaInstalacion. If that range is <500 km
--                  (single-inspection tire with no movement), fall back
--                  to the source row's mileageTraveled — or 0 if unknown.
--
-- Scope: externalSourceId LIKE 'merquepro:%' only. Native TirePro data untouched.
-- Idempotent. Already applied to prod 2026-04-21.
-- =============================================================================

BEGIN;
SET LOCAL statement_timeout = '15min';

-- STEP 1 — compute vida-scoped km for every merquepro tire into a temp table.
-- Temp-table pattern avoids the per-row correlated subquery that would
-- stall under load; this completes in <30s for 97k tires.
CREATE TEMP TABLE _new_km ON COMMIT DROP AS
SELECT t.id AS tire_id,
       LEAST(250000, GREATEST(0,
         CASE
           WHEN COALESCE(
             MAX(i."kmActualVehiculo") FILTER (
               WHERE i."kmActualVehiculo" > 0
                 AND (t."fechaInstalacion" IS NULL OR i.fecha >= t."fechaInstalacion")
                 AND i."vidaAlMomento" = t."vidaActual"
             ) -
             MIN(i."kmActualVehiculo") FILTER (
               WHERE i."kmActualVehiculo" > 0
                 AND (t."fechaInstalacion" IS NULL OR i.fecha >= t."fechaInstalacion")
                 AND i."vidaAlMomento" = t."vidaActual"
             ), 0
           ) > 500
           THEN COALESCE(
             MAX(i."kmActualVehiculo") FILTER (
               WHERE i."kmActualVehiculo" > 0
                 AND (t."fechaInstalacion" IS NULL OR i.fecha >= t."fechaInstalacion")
                 AND i."vidaAlMomento" = t."vidaActual"
             ) -
             MIN(i."kmActualVehiculo") FILTER (
               WHERE i."kmActualVehiculo" > 0
                 AND (t."fechaInstalacion" IS NULL OR i.fecha >= t."fechaInstalacion")
                 AND i."vidaAlMomento" = t."vidaActual"
             ), 0
           )
           ELSE ROUND(COALESCE((t."sourceMetadata"->>'mileageTraveled')::float, 0))::int
         END
       )) AS km
  FROM "Tire" t
  LEFT JOIN inspecciones i ON i."tireId" = t.id
 WHERE t."externalSourceId" LIKE 'merquepro:%' AND t."vidaActual"::text <> 'fin'
 GROUP BY t.id, t."fechaInstalacion", t."vidaActual", t."sourceMetadata";

UPDATE "Tire" t SET "kilometrosRecorridos" = n.km
  FROM _new_km n WHERE t.id = n.tire_id AND t."kilometrosRecorridos" <> n.km;

-- STEP 2 — recompute projectedKmRemaining from the new km.
UPDATE "Tire" t
   SET "projectedKmRemaining" = ROUND(LEAST(250000.0, GREATEST(0.0, (
     CASE
       WHEN t."kilometrosRecorridos" = 0 THEN 0.0
       WHEN (t."sourceMetadata"->>'mileageProyected')::float > t."kilometrosRecorridos"
         THEN LEAST(2000000.0, (t."sourceMetadata"->>'mileageProyected')::float) - t."kilometrosRecorridos"
       WHEN (t."sourceMetadata"->>'mileageByMillimeter')::float > 0 AND t."profundidadInicial" > 0
         THEN LEAST(2000000.0, (t."sourceMetadata"->>'mileageByMillimeter')::float * t."profundidadInicial") - t."kilometrosRecorridos"
       WHEN t."currentProfundidad" IS NOT NULL AND t."profundidadInicial" > t."currentProfundidad" AND t."currentProfundidad" > 0
         THEN LEAST(2000000.0, t."kilometrosRecorridos"::float * t."currentProfundidad" / (t."profundidadInicial" - t."currentProfundidad"))
       ELSE 0.0
     END
   ))))::int
 WHERE t."externalSourceId" LIKE 'merquepro:%' AND t."vidaActual"::text <> 'fin';

-- STEP 3 — current-life cost aggregate into a temp table (fast path).
CREATE TEMP TABLE _cost_life ON COMMIT DROP AS
SELECT c."tireId", SUM(c.valor)::numeric AS ct
  FROM tire_costos c JOIN "Tire" t ON t.id = c."tireId"
 WHERE t."externalSourceId" LIKE 'merquepro:%'
   AND ((t."vidaActual"::text = 'nueva' AND c.concepto LIKE 'compra_nueva%')
     OR (t."vidaActual"::text LIKE 'reencauche%' AND c.concepto LIKE 'reencauche%')
     OR (t."vidaActual"::text = 'fin'))
 GROUP BY c."tireId";

UPDATE "Tire" t SET "currentCpk" = CASE
     WHEN t."kilometrosRecorridos" = 0 OR (cl.ct / t."kilometrosRecorridos") > 500 THEN NULL
     ELSE ROUND(cl.ct / t."kilometrosRecorridos", 2)
   END
  FROM _cost_life cl WHERE t.id = cl."tireId" AND t."kilometrosRecorridos" > 0;

UPDATE "Tire" t SET "currentCpk" = NULL
 WHERE t."externalSourceId" LIKE 'merquepro:%' AND t."kilometrosRecorridos" = 0 AND t."currentCpk" IS NOT NULL;

-- STEP 4 — every inspection's kmProyectado + cpkProyectado via temp-table join.
CREATE TEMP TABLE _tire_agg ON COMMIT DROP AS
SELECT t.id AS tire_id,
       t."kilometrosRecorridos"::float + COALESCE(t."projectedKmRemaining", 0)::float AS km_p,
       COALESCE(cl.ct::float, 0) AS clc
  FROM "Tire" t LEFT JOIN _cost_life cl ON cl."tireId" = t.id
 WHERE t."externalSourceId" LIKE 'merquepro:%';

UPDATE inspecciones i
   SET "kmProyectado"  = CASE WHEN ta.km_p > 0 THEN ta.km_p ELSE NULL END,
       "cpkProyectado" = CASE
         WHEN ta.km_p > 0 AND ta.clc > 0 THEN LEAST(500, ROUND((ta.clc / ta.km_p)::numeric, 2))
         ELSE NULL
       END
  FROM _tire_agg ta WHERE i."tireId" = ta.tire_id;

-- STEP 5 — clamp any kmEfectivos that still exceeds its tire's km_rec.
UPDATE inspecciones i
   SET "kmEfectivos" = t."kilometrosRecorridos"
  FROM "Tire" t
 WHERE i."tireId" = t.id
   AND t."externalSourceId" LIKE 'merquepro:%'
   AND i."kmEfectivos" IS NOT NULL
   AND t."kilometrosRecorridos" > 0
   AND i."kmEfectivos" > t."kilometrosRecorridos";

COMMIT;
