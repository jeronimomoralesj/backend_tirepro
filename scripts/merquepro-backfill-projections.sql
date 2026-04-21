-- =============================================================================
-- Merquepro data-quality repair:
--   1. Recover Tire.kilometrosRecorridos from inspection kmEfectivos when
--      the tire-level field was left at 0 by the importer.
--   2. Align Tire.profundidadInicial with Merquepro's source of truth
--      (originalDepthRetread for reencauches, else originalDepth).
--   3. Zero out projectedKmRemaining on any tire with km=0 — no wear signal.
--   4. Recompute projectedKmRemaining for worn tires via three-tier fallback.
--   5. Rebuild Tire.currentCpk using CURRENT-LIFE cost only (no lifetime
--      contamination across vida transitions).
--   6. Rebuild latest Inspeccion.kmProyectado + cpkProyectado the same way.
--
-- Idempotent. Already run against prod (2026-04-21).
--
-- Usage:
--   psql "$DATABASE_URL" -f scripts/merquepro-backfill-projections.sql
-- =============================================================================

BEGIN;
SET LOCAL statement_timeout = '15min';

-- 1) Recover km from inspections --------------------------------------------
-- 74k+ tires were imported with km=0 even though their inspections carried
-- kmEfectivos. Take MAX(kmEfectivos) per tire as the current-life km truth.
WITH inspection_km AS (
  SELECT "tireId", COALESCE(MAX("kmEfectivos"), 0) AS max_km
    FROM inspecciones GROUP BY "tireId"
)
UPDATE "Tire" t
   SET "kilometrosRecorridos" = LEAST(ik.max_km, 250000)
  FROM inspection_km ik
 WHERE t.id = ik."tireId"
   AND t."externalSourceId" LIKE 'merquepro:%'
   AND t."kilometrosRecorridos" = 0
   AND t."vidaActual" <> 'fin'
   AND ik.max_km > 500;

-- 2) profundidadInicial aligned with source --------------------------------
UPDATE "Tire" t
   SET "profundidadInicial" =
     COALESCE(
       NULLIF(
         CASE
           WHEN t."vidaActual" <> 'nueva' AND (t."sourceMetadata"->>'originalDepthRetread')::float > 0
             THEN (t."sourceMetadata"->>'originalDepthRetread')::float
           WHEN (t."sourceMetadata"->>'originalDepth')::float > 0
             THEN (t."sourceMetadata"->>'originalDepth')::float
           ELSE NULL
         END, 0),
       t."profundidadInicial"
     )
 WHERE t."externalSourceId" LIKE 'merquepro:%'
   AND t."sourceMetadata" IS NOT NULL;

-- 3) Clear bogus projections on km=0 tires ---------------------------------
UPDATE "Tire" SET "projectedKmRemaining" = 0
 WHERE "externalSourceId" LIKE 'merquepro:%'
   AND "kilometrosRecorridos" = 0
   AND "projectedKmRemaining" IS NOT NULL
   AND "projectedKmRemaining" <> 0;

-- 4) Recompute projectedKmRemaining for worn tires ------------------------
-- Float-clamped at every step so runaway source rows can't overflow int4.
UPDATE "Tire" t
   SET "projectedKmRemaining" = ROUND(LEAST(250000.0, GREATEST(0.0, (
     CASE
       WHEN (t."sourceMetadata"->>'mileageProyected')::float > t."kilometrosRecorridos"
         THEN LEAST(2000000.0, (t."sourceMetadata"->>'mileageProyected')::float) - t."kilometrosRecorridos"
       WHEN (t."sourceMetadata"->>'mileageByMillimeter')::float > 0 AND t."profundidadInicial" > 0
         THEN LEAST(2000000.0, (t."sourceMetadata"->>'mileageByMillimeter')::float * t."profundidadInicial") - t."kilometrosRecorridos"
       WHEN t."currentProfundidad" IS NOT NULL
        AND t."profundidadInicial" > t."currentProfundidad"
        AND t."currentProfundidad" > 0
         THEN LEAST(2000000.0, t."kilometrosRecorridos"::float * t."currentProfundidad" / (t."profundidadInicial" - t."currentProfundidad"))
       ELSE 0.0
     END
   ))))::int
 WHERE t."externalSourceId" LIKE 'merquepro:%'
   AND t."kilometrosRecorridos" > 0
   AND t."vidaActual" <> 'fin';

-- 5) Tire.currentCpk from current-life cost only ---------------------------
-- Cost conceptos are tagged per life (compra_nueva* vs reencauche*) by the
-- importer, so matching by prefix against vidaActual keeps per-life CPK
-- honest even when multiple life transitions have deposited costs.
WITH current_life_cost AS (
  SELECT c."tireId", SUM(c.valor)::numeric AS cost_total
    FROM tire_costos c
    JOIN "Tire" t ON t.id = c."tireId"
   WHERE t."externalSourceId" LIKE 'merquepro:%'
     AND t."kilometrosRecorridos" > 0
     AND (
       (t."vidaActual"::text = 'nueva'           AND c.concepto LIKE 'compra_nueva%')
    OR (t."vidaActual"::text LIKE 'reencauche%'  AND c.concepto LIKE 'reencauche%')
    OR (t."vidaActual"::text = 'fin')
     )
   GROUP BY c."tireId"
)
UPDATE "Tire" t
   SET "currentCpk" = CASE
     WHEN (clc.cost_total / t."kilometrosRecorridos") > 500 THEN NULL
     ELSE ROUND(clc.cost_total / t."kilometrosRecorridos", 2)
   END
  FROM current_life_cost clc
 WHERE t.id = clc."tireId"
   AND t."kilometrosRecorridos" > 0;

-- 6) Inspeccion.kmProyectado + cpkProyectado for EVERY inspection ---------
-- Applied uniformly to every inspection of every worn tire — not just the
-- latest — so the per-inspection history view never shows a missing cell.
-- Invariant: kmProyectado >= kilometrosRecorridos (recall projectedKmRemaining
-- is always >= 0). kmProy < kmRec is impossible by construction.
WITH tire_agg AS (
  SELECT t.id AS tire_id,
         t."kilometrosRecorridos"::float + COALESCE(t."projectedKmRemaining", 0)::float AS total_km_proy,
    COALESCE(
      (SELECT SUM(c.valor)::float FROM tire_costos c
        WHERE c."tireId" = t.id
          AND (
            (t."vidaActual"::text = 'nueva'           AND c.concepto LIKE 'compra_nueva%')
         OR (t."vidaActual"::text LIKE 'reencauche%'  AND c.concepto LIKE 'reencauche%')
         OR (t."vidaActual"::text = 'fin')
          )
      ), 0) AS current_life_cost
    FROM "Tire" t
   WHERE t."externalSourceId" LIKE 'merquepro:%'
     AND t."kilometrosRecorridos" > 0
     AND t."vidaActual"::text <> 'fin'
)
UPDATE inspecciones i
   SET "kmProyectado" = CASE
         WHEN ta.total_km_proy > 0 THEN ta.total_km_proy
         ELSE i."kmProyectado"
       END,
       "cpkProyectado" = CASE
         WHEN ta.total_km_proy > 0 AND ta.current_life_cost > 0
           THEN LEAST(500, ROUND((ta.current_life_cost / ta.total_km_proy)::numeric, 2))
         ELSE i."cpkProyectado"
       END
  FROM tire_agg ta
 WHERE i."tireId" = ta.tire_id;

-- 7) Clear projections on unworn tires — EVERY inspection, not just latest --
UPDATE inspecciones i
   SET "kmProyectado"  = NULL,
       "cpkProyectado" = NULL
  FROM "Tire" t
 WHERE i."tireId" = t.id
   AND t."externalSourceId" LIKE 'merquepro:%'
   AND t."kilometrosRecorridos" = 0;

COMMIT;
