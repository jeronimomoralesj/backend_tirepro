-- =============================================================================
-- Merquepro data-quality cleanup (2026-04-21):
--   1. Delete duplicate synthetic inspections (rows where all zones exactly
--      match the tire's profundidadInicial) — keep only the latest per tire.
--   2. Re-sync Tire.kilometrosRecorridos from inspection km signals.
--   3. Clear bogus kmProyectado/cpkProyectado on unworn tires or when
--      cpk == cpkProyectado (projection isn't really projecting).
--   4. Clamp depth regressions within a vida (depth cannot increase without
--      a reencauche).
--
-- Scope: only tires with externalSourceId LIKE 'merquepro:%'.
-- Non-migration TirePro data is untouched.
--
-- Idempotent. Already run against prod. Usage:
--   psql "$DATABASE_URL" -f scripts/merquepro-dedupe-synth-inspections.sql
-- =============================================================================

BEGIN;
SET LOCAL statement_timeout = '15min';

-- 1) Dedupe synthetic inspections ------------------------------------------
WITH synth AS (
  SELECT i.id, i."tireId",
         ROW_NUMBER() OVER (PARTITION BY i."tireId" ORDER BY i.fecha DESC, i.id DESC) AS rn
    FROM inspecciones i
    JOIN "Tire" t ON t.id = i."tireId"
   WHERE t."externalSourceId" LIKE 'merquepro:%'
     AND ABS(i."profundidadInt" - t."profundidadInicial") < 0.01
     AND ABS(i."profundidadCen" - t."profundidadInicial") < 0.01
     AND ABS(i."profundidadExt" - t."profundidadInicial") < 0.01
)
DELETE FROM inspecciones i
 USING synth s
 WHERE i.id = s.id AND s.rn > 1;

-- 2) Re-sync Tire.kilometrosRecorridos -------------------------------------
WITH insp_km AS (
  SELECT "tireId",
         COALESCE(MAX("kmEfectivos"), 0) AS max_eff,
         COALESCE(MAX("kmActualVehiculo") FILTER (WHERE "kmActualVehiculo" > 0), 0)
           - COALESCE(MIN("kmActualVehiculo") FILTER (WHERE "kmActualVehiculo" > 0), 0) AS range_km
    FROM inspecciones
   GROUP BY "tireId"
)
UPDATE "Tire" t
   SET "kilometrosRecorridos" = LEAST(
     250000,
     GREATEST(t."kilometrosRecorridos", ik.max_eff, ik.range_km)
   )
  FROM insp_km ik
 WHERE t.id = ik."tireId"
   AND t."externalSourceId" LIKE 'merquepro:%'
   AND t."vidaActual"::text <> 'fin'
   AND GREATEST(ik.max_eff, ik.range_km) > t."kilometrosRecorridos" + 500;

-- 3) Clear bogus projections on unworn tires ------------------------------
WITH latest AS (
  SELECT DISTINCT ON (i."tireId") i.id, i."tireId", i.cpk, i."cpkProyectado"
    FROM inspecciones i
    JOIN "Tire" t ON t.id = i."tireId"
   WHERE t."externalSourceId" LIKE 'merquepro:%'
   ORDER BY i."tireId", i.fecha DESC
)
UPDATE inspecciones i
   SET "cpkProyectado" = NULL,
       "kmProyectado"  = NULL
  FROM latest li
  JOIN "Tire" t ON t.id = li."tireId"
 WHERE i.id = li.id
   AND (
     (t."currentProfundidad" IS NOT NULL
      AND ABS(t."currentProfundidad" - t."profundidadInicial") < 0.1)
     OR
     (li.cpk IS NOT NULL AND li."cpkProyectado" IS NOT NULL
      AND ABS(li.cpk - li."cpkProyectado") < 0.01)
   );

-- 4) Clamp depth regressions within a vida --------------------------------
WITH ranked AS (
  SELECT i.id, i."tireId", i.fecha, i."vidaAlMomento",
         i."profundidadInt", i."profundidadCen", i."profundidadExt",
         LAG(i."profundidadInt") OVER (PARTITION BY i."tireId", i."vidaAlMomento" ORDER BY i.fecha) AS prev_int,
         LAG(i."profundidadCen") OVER (PARTITION BY i."tireId", i."vidaAlMomento" ORDER BY i.fecha) AS prev_cen,
         LAG(i."profundidadExt") OVER (PARTITION BY i."tireId", i."vidaAlMomento" ORDER BY i.fecha) AS prev_ext
    FROM inspecciones i
    JOIN "Tire" t ON t.id = i."tireId"
   WHERE t."externalSourceId" LIKE 'merquepro:%'
)
UPDATE inspecciones i
   SET "profundidadInt" = LEAST(r."profundidadInt", r.prev_int),
       "profundidadCen" = LEAST(r."profundidadCen", r.prev_cen),
       "profundidadExt" = LEAST(r."profundidadExt", r.prev_ext)
  FROM ranked r
 WHERE i.id = r.id
   AND r.prev_int IS NOT NULL
   AND (
     r."profundidadInt" > r.prev_int + 1.0
  OR r."profundidadCen" > r.prev_cen + 1.0
  OR r."profundidadExt" > r.prev_ext + 1.0
   );

COMMIT;
