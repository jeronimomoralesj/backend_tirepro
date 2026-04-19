-- =============================================================================
-- One-shot backfill: populate TireBenchmark from every distinct SKU's
-- first-party inspection + cost history. Runs in < 10s on 100k tires.
--
-- Usage:
--   psql "$DATABASE_URL" -f scripts/rebuild-tire-benchmarks.sql
-- =============================================================================

BEGIN;

WITH normalized AS (
  SELECT
    LOWER(TRIM(marca))     AS marca_key,
    LOWER(TRIM(diseno))    AS diseno_key,
    LOWER(TRIM(dimension)) AS dimension_key,
    "companyId",
    id,
    "lifetimeCpk",
    "kilometrosRecorridos",
    "vidaActual"
  FROM "Tire"
  WHERE marca IS NOT NULL AND TRIM(marca) <> ''
    AND diseno IS NOT NULL AND TRIM(diseno) <> ''
    AND dimension IS NOT NULL AND TRIM(dimension) <> ''
),
tire_agg AS (
  SELECT
    marca_key, diseno_key, dimension_key,
    COUNT(DISTINCT id)::int          AS sample_size,
    COUNT(DISTINCT "companyId")::int AS company_count,
    AVG("lifetimeCpk") FILTER (WHERE "lifetimeCpk" > 0) AS avg_cpk,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY "lifetimeCpk")
      FILTER (WHERE "lifetimeCpk" > 0) AS median_cpk,
    AVG("kilometrosRecorridos")
      FILTER (WHERE "vidaActual" = 'fin' AND "kilometrosRecorridos" > 0) AS avg_km_por_vida
  FROM normalized
  GROUP BY marca_key, diseno_key, dimension_key
),
inspec_normalized AS (
  SELECT
    LOWER(TRIM(t.marca))     AS marca_key,
    LOWER(TRIM(t.diseno))    AS diseno_key,
    LOWER(TRIM(t.dimension)) AS dimension_key,
    i."vidaAlMomento",
    i.cpk, i.cpt,
    i."profundidadInt", i."profundidadCen", i."profundidadExt",
    i."kmEfectivos",
    t."profundidadInicial",
    i."presionDelta"
  FROM inspecciones i
  JOIN "Tire" t ON i."tireId" = t.id
  WHERE t.marca IS NOT NULL AND TRIM(t.marca) <> ''
    AND t.diseno IS NOT NULL AND TRIM(t.diseno) <> ''
    AND t.dimension IS NOT NULL AND TRIM(t.dimension) <> ''
),
vida_agg AS (
  SELECT
    marca_key, diseno_key, dimension_key,
    AVG(cpk) FILTER (WHERE "vidaAlMomento" = 'nueva'       AND cpk > 0) AS cpk_nueva,
    AVG(cpk) FILTER (WHERE "vidaAlMomento" = 'reencauche1' AND cpk > 0) AS cpk_r1,
    AVG(cpk) FILTER (WHERE "vidaAlMomento" = 'reencauche2' AND cpk > 0) AS cpk_r2,
    COUNT(*) FILTER (WHERE "vidaAlMomento" = 'nueva')::int       AS sample_nueva,
    COUNT(*) FILTER (WHERE "vidaAlMomento" = 'reencauche1')::int AS sample_r1,
    COUNT(*) FILTER (WHERE "vidaAlMomento" = 'reencauche2')::int AS sample_r2,
    AVG(cpt) FILTER (WHERE cpt > 0) AS avg_cpt,
    AVG("profundidadInicial" - LEAST("profundidadInt", "profundidadCen", "profundidadExt"))
      FILTER (
        WHERE "profundidadInicial" > 0
          AND "profundidadInt" IS NOT NULL
          AND "profundidadCen" IS NOT NULL
          AND "profundidadExt" IS NOT NULL
      ) AS avg_mm_desgaste,
    AVG(
      CASE WHEN "kmEfectivos" > 0 AND "profundidadInicial" > 0
             AND "profundidadInt" IS NOT NULL AND "profundidadCen" IS NOT NULL AND "profundidadExt" IS NOT NULL
           THEN ("profundidadInicial" - LEAST("profundidadInt", "profundidadCen", "profundidadExt"))
                * 1000.0 / "kmEfectivos"
           ELSE NULL END
    ) AS avg_desgaste_per_1000km,
    AVG(cpk) FILTER (WHERE ABS("presionDelta") <= 5 AND cpk > 0) AS cpk_optimal_psi,
    AVG(cpk) FILTER (WHERE "presionDelta" < -10     AND cpk > 0) AS cpk_low_psi
  FROM inspec_normalized
  GROUP BY marca_key, diseno_key, dimension_key
),
costo_agg AS (
  SELECT
    LOWER(TRIM(t.marca))     AS marca_key,
    LOWER(TRIM(t.diseno))    AS diseno_key,
    LOWER(TRIM(t.dimension)) AS dimension_key,
    AVG(tc.valor) FILTER (
      WHERE (tc.concepto = 'compra_nueva' OR tc.concepto = '' OR tc.concepto IS NULL)
        AND tc.valor > 0
    ) AS precio_promedio,
    MIN(tc.valor) FILTER (
      WHERE (tc.concepto = 'compra_nueva' OR tc.concepto = '' OR tc.concepto IS NULL)
        AND tc.valor > 0
    ) AS precio_min,
    MAX(tc.valor) FILTER (
      WHERE (tc.concepto = 'compra_nueva' OR tc.concepto = '' OR tc.concepto IS NULL)
        AND tc.valor > 0
    ) AS precio_max
  FROM tire_costos tc
  JOIN "Tire" t ON tc."tireId" = t.id
  WHERE t.marca IS NOT NULL AND TRIM(t.marca) <> ''
    AND t.diseno IS NOT NULL AND TRIM(t.diseno) <> ''
    AND t.dimension IS NOT NULL AND TRIM(t.dimension) <> ''
  GROUP BY marca_key, diseno_key, dimension_key
)
INSERT INTO tire_benchmarks (
  id, marca, diseno, dimension,
  "sampleSize", "companyCount",
  "precioPromedio", "precioMin", "precioMax",
  "avgCpk", "medianCpk", "avgCpt",
  "avgKmPorVida", "avgMmDesgaste", "avgDesgastePor1000km",
  "cpkNueva", "cpkReencauche1", "cpkReencauche2",
  "sampleNueva", "sampleReencauche1", "sampleReencauche2",
  "retreadRoiRatio",
  "cpkAtOptimalPsi", "cpkAtLowPsi", "pressureSensitivity",
  "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(),
  t.marca_key, t.diseno_key, t.dimension_key,
  t.sample_size, t.company_count,
  c.precio_promedio, c.precio_min, c.precio_max,
  t.avg_cpk, t.median_cpk, v.avg_cpt,
  t.avg_km_por_vida, v.avg_mm_desgaste, v.avg_desgaste_per_1000km,
  v.cpk_nueva, v.cpk_r1, v.cpk_r2,
  COALESCE(v.sample_nueva, 0), COALESCE(v.sample_r1, 0), COALESCE(v.sample_r2, 0),
  -- retreadRoiRatio: km per vida on reencauche1 / km per vida on nueva.
  -- Approximated here as cpkNueva / cpkReencauche1 (same km basis, inverse
  -- cost ratio). >1.0 means retread is cheaper per km than new.
  CASE WHEN v.cpk_nueva IS NOT NULL AND v.cpk_r1 IS NOT NULL AND v.cpk_r1 > 0
       THEN ROUND((v.cpk_nueva / v.cpk_r1)::numeric, 3)::float
       ELSE NULL END,
  v.cpk_optimal_psi, v.cpk_low_psi,
  -- pressureSensitivity: % CPK degradation between optimal and >10 PSI under.
  CASE WHEN v.cpk_optimal_psi IS NOT NULL AND v.cpk_low_psi IS NOT NULL AND v.cpk_optimal_psi > 0
       THEN ROUND((((v.cpk_low_psi - v.cpk_optimal_psi) / v.cpk_optimal_psi) * 100)::numeric, 2)::float
       ELSE NULL END,
  NOW(), NOW()
FROM tire_agg t
LEFT JOIN vida_agg  v USING (marca_key, diseno_key, dimension_key)
LEFT JOIN costo_agg c USING (marca_key, diseno_key, dimension_key)
ON CONFLICT (marca, diseno, dimension) DO UPDATE SET
  "sampleSize"           = EXCLUDED."sampleSize",
  "companyCount"         = EXCLUDED."companyCount",
  "precioPromedio"       = EXCLUDED."precioPromedio",
  "precioMin"            = EXCLUDED."precioMin",
  "precioMax"            = EXCLUDED."precioMax",
  "avgCpk"               = EXCLUDED."avgCpk",
  "medianCpk"            = EXCLUDED."medianCpk",
  "avgCpt"               = EXCLUDED."avgCpt",
  "avgKmPorVida"         = EXCLUDED."avgKmPorVida",
  "avgMmDesgaste"        = EXCLUDED."avgMmDesgaste",
  "avgDesgastePor1000km" = EXCLUDED."avgDesgastePor1000km",
  "cpkNueva"             = EXCLUDED."cpkNueva",
  "cpkReencauche1"       = EXCLUDED."cpkReencauche1",
  "cpkReencauche2"       = EXCLUDED."cpkReencauche2",
  "sampleNueva"          = EXCLUDED."sampleNueva",
  "sampleReencauche1"    = EXCLUDED."sampleReencauche1",
  "sampleReencauche2"    = EXCLUDED."sampleReencauche2",
  "retreadRoiRatio"      = EXCLUDED."retreadRoiRatio",
  "cpkAtOptimalPsi"      = EXCLUDED."cpkAtOptimalPsi",
  "cpkAtLowPsi"          = EXCLUDED."cpkAtLowPsi",
  "pressureSensitivity"  = EXCLUDED."pressureSensitivity",
  "updatedAt"            = NOW();

COMMIT;
