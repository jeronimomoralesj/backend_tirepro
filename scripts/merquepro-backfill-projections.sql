-- =============================================================================
-- Merquepro data-quality repair #2:
--   1. profundidadInicial — align with source (originalDepthRetread for
--      reencauches, else originalDepth)
--   2. projectedKmRemaining — populate for every worn tire using, in order:
--        (a) source.mileageProyected - kilometrosRecorridos
--        (b) source.mileageByMillimeter × profundidadInicial - kilometrosRecorridos
--        (c) proportional remaining from current vs initial depth
--      Clamped at 250,000 km.
--   3. Latest Inspeccion per worn tire gets kmProyectado + cpkProyectado so
--      the dashboard has the "projected" figures populated.
--
-- Idempotent — safe to re-run.
--
-- Usage:
--   psql "$DATABASE_URL" -f scripts/merquepro-backfill-projections.sql
-- =============================================================================

BEGIN;
SET LOCAL statement_timeout = '15min';

-- 1) profundidadInicial -------------------------------------------------------
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

-- 2) projectedKmRemaining -----------------------------------------------------
-- Every multiplication and difference is clamped to a 2M float ceiling
-- before the final cast to int to prevent overflow from a handful of
-- runaway source rows that reported 10M+ km projections.
UPDATE "Tire" t
   SET "projectedKmRemaining" = ROUND(
     LEAST(
       250000.0,
       GREATEST(0.0, (
         CASE
           WHEN (t."sourceMetadata"->>'mileageProyected')::float > t."kilometrosRecorridos"
             THEN LEAST(2000000.0, (t."sourceMetadata"->>'mileageProyected')::float) - t."kilometrosRecorridos"
           WHEN (t."sourceMetadata"->>'mileageByMillimeter')::float > 0
            AND t."profundidadInicial" > 0
             THEN LEAST(2000000.0, (t."sourceMetadata"->>'mileageByMillimeter')::float * t."profundidadInicial") - t."kilometrosRecorridos"
           WHEN t."currentProfundidad" IS NOT NULL
            AND t."profundidadInicial" > t."currentProfundidad"
            AND t."currentProfundidad" > 0
             THEN LEAST(2000000.0, t."kilometrosRecorridos"::float * t."currentProfundidad" / (t."profundidadInicial" - t."currentProfundidad"))
           ELSE 0.0
         END
       ))
     )
   )::int
 WHERE t."externalSourceId" LIKE 'merquepro:%'
   AND t."kilometrosRecorridos" > 0
   AND t."vidaActual" <> 'fin';

-- 3) Latest Inspeccion kmProyectado + cpkProyectado --------------------------
WITH latest_insp AS (
  SELECT DISTINCT ON (i."tireId") i.id, i."tireId"
    FROM inspecciones i
    JOIN "Tire" t ON t.id = i."tireId"
   WHERE t."externalSourceId" LIKE 'merquepro:%'
     AND t."kilometrosRecorridos" > 0
     AND t."vidaActual" <> 'fin'
   ORDER BY i."tireId", i.fecha DESC
),
tire_agg AS (
  SELECT t.id AS tire_id,
         t."kilometrosRecorridos"::float + COALESCE(t."projectedKmRemaining", 0)::float AS km_total_proy,
         COALESCE((SELECT SUM(valor) FROM tire_costos WHERE "tireId" = t.id), 0)::float AS cost_total
    FROM "Tire" t
   WHERE t."externalSourceId" LIKE 'merquepro:%'
     AND t."kilometrosRecorridos" > 0
     AND t."vidaActual" <> 'fin'
)
UPDATE inspecciones i
   SET "kmProyectado"  = ta.km_total_proy,
       "cpkProyectado" = CASE
         WHEN ta.km_total_proy > 0 AND ta.cost_total > 0
           THEN LEAST(500, ROUND((ta.cost_total / ta.km_total_proy)::numeric, 2))
         ELSE i."cpkProyectado"
       END
  FROM latest_insp li
  JOIN tire_agg   ta ON ta.tire_id = li."tireId"
 WHERE i.id = li.id;

COMMIT;
