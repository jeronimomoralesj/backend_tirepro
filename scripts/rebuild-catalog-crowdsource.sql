-- =============================================================================
-- One-shot backfill: populate TireMasterCatalog.crowd* fields for every
-- SKU that has real tire data, and create crowdsource entries for SKUs
-- not yet in the catalog.
--
-- Usage:
--   psql "$DATABASE_URL" -f scripts/rebuild-catalog-crowdsource.sql
-- =============================================================================

BEGIN;

-- Materialize the aggregation so we can both UPDATE existing rows and
-- INSERT new ones without running the query twice.
CREATE TEMP TABLE crowd_agg AS
WITH tires_norm AS (
  SELECT
    LOWER(TRIM(marca))     AS marca_key,
    LOWER(TRIM(diseno))    AS modelo_key,  -- catalog uses "modelo" = our "diseno"
    LOWER(TRIM(dimension)) AS dimension_key,
    id,
    "companyId",
    "profundidadInicial",
    "currentProfundidad",
    "kilometrosRecorridos",
    "currentCpk",
    "lifetimeCpk"
  FROM "Tire"
  WHERE marca IS NOT NULL AND TRIM(marca) <> ''
    AND diseno IS NOT NULL AND TRIM(diseno) <> ''
    AND dimension IS NOT NULL AND TRIM(dimension) <> ''
),
-- First-vida-only price per tire (compra_nueva concept). Using MIN because
-- a tire may have multiple compra entries — the original purchase is the
-- earliest one, which MIN by fecha approximates.
prices_per_tire AS (
  SELECT DISTINCT ON (tc."tireId")
    tc."tireId",
    tc.valor
  FROM tire_costos tc
  WHERE (tc.concepto = 'compra_nueva' OR tc.concepto = '' OR tc.concepto IS NULL)
    AND tc.valor > 0
  ORDER BY tc."tireId", tc.fecha ASC
),
joined AS (
  SELECT
    t.marca_key, t.modelo_key, t.dimension_key,
    t.id, t."companyId",
    t."profundidadInicial",
    t."currentProfundidad",
    t."kilometrosRecorridos",
    COALESCE(t."currentCpk", t."lifetimeCpk") AS cpk,
    p.valor AS price,
    -- Wear rate: (initialDepth - currentDepth) / (km/1000), only if >5000 km.
    CASE
      WHEN t."profundidadInicial" IS NOT NULL AND t."profundidadInicial" > 0
        AND t."currentProfundidad" IS NOT NULL
        AND t."kilometrosRecorridos" > 5000
      THEN (t."profundidadInicial" - t."currentProfundidad")
           / (t."kilometrosRecorridos" / 1000.0)
      ELSE NULL
    END AS wear_rate
  FROM tires_norm t
  LEFT JOIN prices_per_tire p ON t.id = p."tireId"
)
SELECT
  marca_key,
  modelo_key,
  dimension_key,
  -- Sample counts
  COUNT(*)                          AS sample_size,
  COUNT(DISTINCT "companyId")::int  AS company_count,

  -- Prices
  ROUND(AVG(price) FILTER (WHERE price IS NOT NULL))::int            AS avg_price,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price)
         FILTER (WHERE price IS NOT NULL))::int                      AS median_price,
  ROUND(STDDEV_SAMP(price) FILTER (WHERE price IS NOT NULL))::int    AS stddev_price,
  ROUND(PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY price)
         FILTER (WHERE price IS NOT NULL))::int                      AS p25_price,
  ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY price)
         FILTER (WHERE price IS NOT NULL))::int                      AS p75_price,
  COUNT(*) FILTER (WHERE price IS NOT NULL)                          AS price_n,

  -- Depth (mm)
  ROUND(AVG("profundidadInicial") FILTER (WHERE "profundidadInicial" > 0)::numeric, 1)::float
    AS avg_initial_depth,
  ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY "profundidadInicial")
         FILTER (WHERE "profundidadInicial" > 0))::numeric, 1)::float
    AS median_initial_depth,
  ROUND(STDDEV_SAMP("profundidadInicial") FILTER (WHERE "profundidadInicial" > 0)::numeric, 1)::float
    AS stddev_depth,

  -- Km per vida
  ROUND(AVG("kilometrosRecorridos") FILTER (WHERE "kilometrosRecorridos" > 0))::int    AS avg_km,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY "kilometrosRecorridos")
         FILTER (WHERE "kilometrosRecorridos" > 0))::int                               AS median_km,

  -- CPK (prefer lifetime, fall back to current)
  ROUND(AVG(cpk) FILTER (WHERE cpk > 0)::numeric, 1)::float                            AS avg_cpk,
  ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cpk)
         FILTER (WHERE cpk > 0))::numeric, 1)::float                                   AS median_cpk,

  -- Wear rate (mm per 1000 km)
  ROUND(AVG(wear_rate) FILTER (WHERE wear_rate IS NOT NULL)::numeric, 2)::float        AS avg_wear_rate
FROM joined
GROUP BY marca_key, modelo_key, dimension_key;

-- Confidence score per SKU:
--   conf = min(1, sample/50) * min(1, companies/3)
-- Higher for larger sample sizes and broader company coverage.
ALTER TABLE crowd_agg ADD COLUMN confidence float;
UPDATE crowd_agg SET confidence = ROUND(
  (
    LEAST(1.0, sample_size::float / 50.0)
    * LEAST(1.0, company_count::float / 3.0)
  )::numeric, 2)::float;

-- -----------------------------------------------------------------------------
-- 1) UPDATE existing catalog entries with fresh crowd stats
-- -----------------------------------------------------------------------------
UPDATE tire_master_catalog c
SET
  "crowdSampleSize"         = a.sample_size,
  "crowdCompanyCount"       = a.company_count,
  "crowdConfidence"         = a.confidence,
  "crowdAvgPrice"           = a.avg_price,
  "crowdMedianPrice"        = a.median_price,
  "crowdStddevPrice"        = a.stddev_price,
  "crowdP25Price"           = a.p25_price,
  "crowdP75Price"           = a.p75_price,
  "crowdAvgInitialDepth"    = a.avg_initial_depth,
  "crowdMedianInitialDepth" = a.median_initial_depth,
  "crowdStddevDepth"        = a.stddev_depth,
  "crowdAvgKm"              = a.avg_km,
  "crowdMedianKm"           = a.median_km,
  "crowdAvgCpk"             = a.avg_cpk,
  "crowdMedianCpk"          = a.median_cpk,
  "crowdAvgWearRate"        = a.avg_wear_rate,
  "crowdLastUpdated"        = NOW(),
  -- Backfill structural fields if they were blank. Manufacturer-entered
  -- values always win — we only fill nulls.
  "rtdMm"             = COALESCE(c."rtdMm",             a.median_initial_depth),
  "kmEstimadosReales" = COALESCE(c."kmEstimadosReales", a.median_km),
  "precioCop"         = COALESCE(c."precioCop",         a.median_price),
  "cpkEstimado"       = COALESCE(
    c."cpkEstimado",
    CASE
      WHEN a.median_price IS NOT NULL AND a.median_km IS NOT NULL AND a.median_km > 0
      THEN ROUND((a.median_price::float / a.median_km)::numeric, 2)::float
      ELSE NULL
    END
  ),
  "updatedAt" = NOW()
FROM crowd_agg a
WHERE LOWER(TRIM(c.marca))     = a.marca_key
  AND LOWER(TRIM(c.modelo))    = a.modelo_key
  AND LOWER(TRIM(c.dimension)) = a.dimension_key;

-- -----------------------------------------------------------------------------
-- 2) INSERT new crowdsource entries for SKUs not yet in the catalog
-- -----------------------------------------------------------------------------
INSERT INTO tire_master_catalog (
  id, marca, modelo, dimension, "skuRef",
  fuente,
  "rtdMm", "kmEstimadosReales", "precioCop", "cpkEstimado",
  "crowdSampleSize", "crowdCompanyCount", "crowdConfidence",
  "crowdAvgPrice", "crowdMedianPrice", "crowdStddevPrice",
  "crowdP25Price", "crowdP75Price",
  "crowdAvgInitialDepth", "crowdMedianInitialDepth", "crowdStddevDepth",
  "crowdAvgKm", "crowdMedianKm",
  "crowdAvgCpk", "crowdMedianCpk",
  "crowdAvgWearRate", "crowdLastUpdated",
  "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(),
  a.marca_key, a.modelo_key, a.dimension_key,
  -- skuRef: CROWD-MARCA-MODELO-DIM, uppercase, stripped, truncated to 64.
  -- Append row_number for uniqueness in the unlikely event two normalized
  -- keys collapse to the same slug.
  LEFT(
    'CROWD-' ||
    UPPER(REGEXP_REPLACE(a.marca_key,     '[^a-zA-Z0-9]', '', 'g')) || '-' ||
    UPPER(REGEXP_REPLACE(a.modelo_key,    '[^a-zA-Z0-9]', '', 'g')) || '-' ||
    UPPER(REGEXP_REPLACE(a.dimension_key, '[^a-zA-Z0-9]', '', 'g')),
    64
  ) AS sku_ref,
  'crowdsource',
  a.median_initial_depth,
  a.median_km,
  a.median_price,
  CASE
    WHEN a.median_price IS NOT NULL AND a.median_km IS NOT NULL AND a.median_km > 0
    THEN ROUND((a.median_price::float / a.median_km)::numeric, 2)::float
    ELSE NULL
  END,
  a.sample_size, a.company_count, a.confidence,
  a.avg_price, a.median_price, a.stddev_price,
  a.p25_price, a.p75_price,
  a.avg_initial_depth, a.median_initial_depth, a.stddev_depth,
  a.avg_km, a.median_km,
  a.avg_cpk, a.median_cpk,
  a.avg_wear_rate, NOW(),
  NOW(), NOW()
FROM crowd_agg a
WHERE NOT EXISTS (
  SELECT 1 FROM tire_master_catalog c
  WHERE LOWER(TRIM(c.marca))     = a.marca_key
    AND LOWER(TRIM(c.modelo))    = a.modelo_key
    AND LOWER(TRIM(c.dimension)) = a.dimension_key
)
ON CONFLICT ("skuRef") DO NOTHING;

COMMIT;
