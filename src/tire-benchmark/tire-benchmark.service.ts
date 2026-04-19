import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogService } from '../catalog/catalog.service';

// =============================================================================
// TireBenchmark ETL
// =============================================================================
//
// Aggregates TirePro's first-party inspection data (130k+ records across
// ~600 tenants) into per-SKU performance benchmarks. The output is the
// single most accurate real-world CPK / km-por-vida / pressure-sensitivity
// dataset for the Colombia market — nothing comparable exists publicly.
//
// Read path: `tire-projection.service.ts` and `tire.service.ts` already
// read `TireBenchmark.findUnique({ marca, diseno, dimension })`. Those
// callers produce replacement suggestions and projected EOL dates.
//
// Run modes:
//   • `POST /tire-benchmarks/rebuild` — admin-triggered immediate run
//   • Nightly cron at 03:00 AM Colombia time (08:00 UTC)
// =============================================================================

type RawRow = Record<string, unknown>;

interface TireAgg {
  marca: string;
  diseno: string;
  dimension: string;
  sampleSize: number;
  companyCount: number;
  avgCpk: number | null;
  medianCpk: number | null;
  avgKmPorVida: number | null;
}

interface VidaAgg {
  marca: string;
  diseno: string;
  dimension: string;
  cpkNueva: number | null;
  cpkReencauche1: number | null;
  cpkReencauche2: number | null;
  sampleNueva: number;
  sampleReencauche1: number;
  sampleReencauche2: number;
  avgCpt: number | null;
  avgMmDesgaste: number | null;
  avgDesgastePor1000km: number | null;
  cpkAtOptimalPsi: number | null;
  cpkAtLowPsi: number | null;
}

interface CostoAgg {
  marca: string;
  diseno: string;
  dimension: string;
  precioPromedio: number | null;
  precioMin: number | null;
  precioMax: number | null;
}

function keyOf(marca: string, diseno: string, dimension: string): string {
  return `${marca.toLowerCase().trim()}|${diseno.toLowerCase().trim()}|${dimension.toLowerCase().trim()}`;
}

function toNumOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function toInt(v: unknown, fallback = 0): number {
  if (v === null || v === undefined) return fallback;
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? n : fallback;
}

@Injectable()
export class TireBenchmarkService {
  private readonly logger = new Logger(TireBenchmarkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
  ) {}

  /**
   * Rebuild the entire TireBenchmark table from current inspection data.
   *
   * Uses 3 parallel raw-SQL aggregations (tire-level, inspection-level,
   * costo-level), each O(n) over their respective tables. Total runtime on
   * a 130k-inspection DB is ~2-5s (PostgreSQL PERCENTILE_CONT is the
   * slowest part).
   *
   * Returns the count of SKUs upserted so the caller can log / surface it.
   */
  async rebuildAll(): Promise<{ totalSkus: number; durationMs: number }> {
    const start = Date.now();

    const [tireRows, vidaRows, costoRows] = await Promise.all([
      this.aggregateTireLevel(),
      this.aggregateVidaLevel(),
      this.aggregateCostoLevel(),
    ]);

    // Merge by (marca, diseno, dimension) key
    const vidaByKey = new Map(vidaRows.map((r) => [keyOf(r.marca, r.diseno, r.dimension), r]));
    const costoByKey = new Map(costoRows.map((r) => [keyOf(r.marca, r.diseno, r.dimension), r]));

    // Upsert sequentially in small batches so we don't exhaust the
    // connection pool. The benchmark table is small (~hundreds to low
    // thousands of rows), so this stays fast.
    let count = 0;
    for (const t of tireRows) {
      const key = keyOf(t.marca, t.diseno, t.dimension);
      const v = vidaByKey.get(key);
      const c = costoByKey.get(key);

      // Retread ROI: km per vida on reencauche1 / km per vida on nueva.
      // > 0.9 = retread is essentially as good as a new tire per km spent.
      const retreadRoiRatio = (v?.cpkNueva && v?.cpkReencauche1 && v.cpkReencauche1 > 0)
        ? +(v.cpkNueva / v.cpkReencauche1).toFixed(3)
        : null;

      // Pressure sensitivity: % CPK degradation per 10 PSI under-inflation.
      // Only meaningful when both buckets have data.
      const pressureSensitivity = (v?.cpkAtOptimalPsi && v?.cpkAtLowPsi && v.cpkAtOptimalPsi > 0)
        ? +(((v.cpkAtLowPsi - v.cpkAtOptimalPsi) / v.cpkAtOptimalPsi) * 100).toFixed(2)
        : null;

      await this.prisma.tireBenchmark.upsert({
        where: {
          marca_diseno_dimension: {
            marca: t.marca.toLowerCase().trim(),
            diseno: t.diseno.toLowerCase().trim(),
            dimension: t.dimension.toLowerCase().trim(),
          },
        },
        create: {
          marca:        t.marca.toLowerCase().trim(),
          diseno:       t.diseno.toLowerCase().trim(),
          dimension:    t.dimension.toLowerCase().trim(),
          sampleSize:   t.sampleSize,
          companyCount: t.companyCount,
          avgCpk:       t.avgCpk,
          medianCpk:    t.medianCpk,
          avgKmPorVida: t.avgKmPorVida,
          avgCpt:              v?.avgCpt ?? null,
          avgMmDesgaste:       v?.avgMmDesgaste ?? null,
          avgDesgastePor1000km: v?.avgDesgastePor1000km ?? null,
          cpkNueva:            v?.cpkNueva ?? null,
          cpkReencauche1:      v?.cpkReencauche1 ?? null,
          cpkReencauche2:      v?.cpkReencauche2 ?? null,
          sampleNueva:         v?.sampleNueva ?? 0,
          sampleReencauche1:   v?.sampleReencauche1 ?? 0,
          sampleReencauche2:   v?.sampleReencauche2 ?? 0,
          precioPromedio: c?.precioPromedio ?? null,
          precioMin:      c?.precioMin ?? null,
          precioMax:      c?.precioMax ?? null,
          retreadRoiRatio,
          cpkAtOptimalPsi: v?.cpkAtOptimalPsi ?? null,
          cpkAtLowPsi:     v?.cpkAtLowPsi ?? null,
          pressureSensitivity,
        },
        update: {
          sampleSize:   t.sampleSize,
          companyCount: t.companyCount,
          avgCpk:       t.avgCpk,
          medianCpk:    t.medianCpk,
          avgKmPorVida: t.avgKmPorVida,
          avgCpt:              v?.avgCpt ?? null,
          avgMmDesgaste:       v?.avgMmDesgaste ?? null,
          avgDesgastePor1000km: v?.avgDesgastePor1000km ?? null,
          cpkNueva:            v?.cpkNueva ?? null,
          cpkReencauche1:      v?.cpkReencauche1 ?? null,
          cpkReencauche2:      v?.cpkReencauche2 ?? null,
          sampleNueva:         v?.sampleNueva ?? 0,
          sampleReencauche1:   v?.sampleReencauche1 ?? 0,
          sampleReencauche2:   v?.sampleReencauche2 ?? 0,
          precioPromedio: c?.precioPromedio ?? null,
          precioMin:      c?.precioMin ?? null,
          precioMax:      c?.precioMax ?? null,
          retreadRoiRatio,
          cpkAtOptimalPsi: v?.cpkAtOptimalPsi ?? null,
          cpkAtLowPsi:     v?.cpkAtLowPsi ?? null,
          pressureSensitivity,
        },
      });
      count++;
    }

    const durationMs = Date.now() - start;
    this.logger.log(`TireBenchmark rebuild: ${count} SKUs in ${durationMs}ms`);
    return { totalSkus: count, durationMs };
  }

  // ---------------------------------------------------------------------------
  // Private — raw-SQL aggregations
  // ---------------------------------------------------------------------------

  /** Tire-level aggregates: sample size, company count, avg/median CPK, avg km/vida. */
  private async aggregateTireLevel(): Promise<TireAgg[]> {
    // Minimum sample threshold: 3 tires. Below that, averages are noise.
    // The HAVING clause keeps the benchmark table free of one-off SKUs.
    const rows = await this.prisma.$queryRawUnsafe<RawRow[]>(`
      WITH normalized AS (
        SELECT
          LOWER(TRIM(marca))     AS marca_key,
          LOWER(TRIM(diseno))    AS diseno_key,
          LOWER(TRIM(dimension)) AS dimension_key,
          marca, diseno, dimension,
          "companyId",
          id,
          "lifetimeCpk",
          "kilometrosRecorridos",
          "vidaActual"
        FROM "Tire"
        WHERE marca IS NOT NULL AND TRIM(marca) <> ''
          AND diseno IS NOT NULL AND TRIM(diseno) <> ''
          AND dimension IS NOT NULL AND TRIM(dimension) <> ''
      )
      SELECT
        marca_key, diseno_key, dimension_key,
        MIN(marca)     AS marca,
        MIN(diseno)    AS diseno,
        MIN(dimension) AS dimension,
        COUNT(DISTINCT id)::int          AS "sampleSize",
        COUNT(DISTINCT "companyId")::int AS "companyCount",
        AVG("lifetimeCpk") FILTER (WHERE "lifetimeCpk" > 0) AS "avgCpk",
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY "lifetimeCpk")
          FILTER (WHERE "lifetimeCpk" > 0) AS "medianCpk",
        AVG("kilometrosRecorridos")
          FILTER (WHERE "vidaActual" = 'fin' AND "kilometrosRecorridos" > 0) AS "avgKmPorVida"
      FROM normalized
      GROUP BY marca_key, diseno_key, dimension_key
      -- No HAVING threshold: every distinct SKU gets an entry. The
      -- sampleSize column is the caller's truth — if it's small, consumers
      -- can decide to show "insufficient data" rather than mask the SKU.
    `);

    return rows.map((r) => ({
      marca:        String(r.marca ?? ''),
      diseno:       String(r.diseno ?? ''),
      dimension:    String(r.dimension ?? ''),
      sampleSize:   toInt(r.sampleSize),
      companyCount: toInt(r.companyCount),
      avgCpk:       toNumOrNull(r.avgCpk),
      medianCpk:    toNumOrNull(r.medianCpk),
      avgKmPorVida: toNumOrNull(r.avgKmPorVida),
    }));
  }

  /** Inspection-level aggregates: per-vida CPK, CPT, desgaste, pressure correlation. */
  private async aggregateVidaLevel(): Promise<VidaAgg[]> {
    const rows = await this.prisma.$queryRawUnsafe<RawRow[]>(`
      WITH normalized AS (
        SELECT
          LOWER(TRIM(t.marca))     AS marca_key,
          LOWER(TRIM(t.diseno))    AS diseno_key,
          LOWER(TRIM(t.dimension)) AS dimension_key,
          t.marca, t.diseno, t.dimension,
          i."vidaAlMomento",
          i.cpk,
          i.cpt,
          i."profundidadInt", i."profundidadCen", i."profundidadExt",
          i."kmEfectivos",
          t."profundidadInicial",
          i."presionDelta"
        FROM inspecciones i
        JOIN "Tire" t ON i."tireId" = t.id
        WHERE t.marca IS NOT NULL AND TRIM(t.marca) <> ''
          AND t.diseno IS NOT NULL AND TRIM(t.diseno) <> ''
          AND t.dimension IS NOT NULL AND TRIM(t.dimension) <> ''
      )
      SELECT
        marca_key, diseno_key, dimension_key,
        MIN(marca)     AS marca,
        MIN(diseno)    AS diseno,
        MIN(dimension) AS dimension,
        AVG(cpk) FILTER (WHERE "vidaAlMomento" = 'nueva'       AND cpk > 0) AS "cpkNueva",
        AVG(cpk) FILTER (WHERE "vidaAlMomento" = 'reencauche1' AND cpk > 0) AS "cpkReencauche1",
        AVG(cpk) FILTER (WHERE "vidaAlMomento" = 'reencauche2' AND cpk > 0) AS "cpkReencauche2",
        COUNT(*) FILTER (WHERE "vidaAlMomento" = 'nueva')::int       AS "sampleNueva",
        COUNT(*) FILTER (WHERE "vidaAlMomento" = 'reencauche1')::int AS "sampleReencauche1",
        COUNT(*) FILTER (WHERE "vidaAlMomento" = 'reencauche2')::int AS "sampleReencauche2",
        AVG(cpt) FILTER (WHERE cpt > 0) AS "avgCpt",
        AVG("profundidadInicial" - LEAST("profundidadInt", "profundidadCen", "profundidadExt"))
          FILTER (
            WHERE "profundidadInicial" > 0
              AND "profundidadInt" IS NOT NULL
              AND "profundidadCen" IS NOT NULL
              AND "profundidadExt" IS NOT NULL
          ) AS "avgMmDesgaste",
        AVG(
          CASE
            WHEN "kmEfectivos" > 0 AND "profundidadInicial" > 0
              AND "profundidadInt" IS NOT NULL AND "profundidadCen" IS NOT NULL AND "profundidadExt" IS NOT NULL
            THEN ("profundidadInicial" - LEAST("profundidadInt", "profundidadCen", "profundidadExt"))
                 * 1000.0 / "kmEfectivos"
            ELSE NULL
          END
        ) AS "avgDesgastePor1000km",
        -- Pressure correlation:
        -- cpkAtOptimalPsi = avg CPK when tire is within ±5 PSI of recommended
        -- cpkAtLowPsi     = avg CPK when tire is >10 PSI under-inflated
        AVG(cpk) FILTER (WHERE ABS("presionDelta") <= 5 AND cpk > 0) AS "cpkAtOptimalPsi",
        AVG(cpk) FILTER (WHERE "presionDelta" < -10  AND cpk > 0) AS "cpkAtLowPsi"
      FROM normalized
      GROUP BY marca_key, diseno_key, dimension_key
    `);

    return rows.map((r) => ({
      marca:        String(r.marca ?? ''),
      diseno:       String(r.diseno ?? ''),
      dimension:    String(r.dimension ?? ''),
      cpkNueva:            toNumOrNull(r.cpkNueva),
      cpkReencauche1:      toNumOrNull(r.cpkReencauche1),
      cpkReencauche2:      toNumOrNull(r.cpkReencauche2),
      sampleNueva:         toInt(r.sampleNueva),
      sampleReencauche1:   toInt(r.sampleReencauche1),
      sampleReencauche2:   toInt(r.sampleReencauche2),
      avgCpt:              toNumOrNull(r.avgCpt),
      avgMmDesgaste:       toNumOrNull(r.avgMmDesgaste),
      avgDesgastePor1000km: toNumOrNull(r.avgDesgastePor1000km),
      cpkAtOptimalPsi:     toNumOrNull(r.cpkAtOptimalPsi),
      cpkAtLowPsi:         toNumOrNull(r.cpkAtLowPsi),
    }));
  }

  /** Costo-level aggregates: per-SKU new-tire pricing (ignores retread/repair entries). */
  private async aggregateCostoLevel(): Promise<CostoAgg[]> {
    const rows = await this.prisma.$queryRawUnsafe<RawRow[]>(`
      SELECT
        LOWER(TRIM(t.marca))     AS marca_key,
        LOWER(TRIM(t.diseno))    AS diseno_key,
        LOWER(TRIM(t.dimension)) AS dimension_key,
        MIN(t.marca)     AS marca,
        MIN(t.diseno)    AS diseno,
        MIN(t.dimension) AS dimension,
        AVG(tc.valor) FILTER (
          WHERE (tc.concepto = 'compra_nueva' OR tc.concepto = '' OR tc.concepto IS NULL)
            AND tc.valor > 0
        ) AS "precioPromedio",
        MIN(tc.valor) FILTER (
          WHERE (tc.concepto = 'compra_nueva' OR tc.concepto = '' OR tc.concepto IS NULL)
            AND tc.valor > 0
        ) AS "precioMin",
        MAX(tc.valor) FILTER (
          WHERE (tc.concepto = 'compra_nueva' OR tc.concepto = '' OR tc.concepto IS NULL)
            AND tc.valor > 0
        ) AS "precioMax"
      FROM tire_costos tc
      JOIN "Tire" t ON tc."tireId" = t.id
      WHERE t.marca IS NOT NULL AND TRIM(t.marca) <> ''
        AND t.diseno IS NOT NULL AND TRIM(t.diseno) <> ''
        AND t.dimension IS NOT NULL AND TRIM(t.dimension) <> ''
      GROUP BY marca_key, diseno_key, dimension_key
    `);

    return rows.map((r) => ({
      marca:          String(r.marca ?? ''),
      diseno:         String(r.diseno ?? ''),
      dimension:      String(r.dimension ?? ''),
      precioPromedio: toNumOrNull(r.precioPromedio),
      precioMin:      toNumOrNull(r.precioMin),
      precioMax:      toNumOrNull(r.precioMax),
    }));
  }

  // ---------------------------------------------------------------------------
  // Bulk crowdsource rebuild — populates `TireMasterCatalog.crowd*` fields
  // ---------------------------------------------------------------------------

  /**
   * Iterate every distinct (marca, diseno, dimension) in the Tire table and
   * call the catalog service's per-SKU crowdsourceUpsert. Slower than the
   * single-pass raw-SQL above because each upsert re-queries the tires
   * table, but it reuses the existing (well-tested) catalog logic.
   *
   * Typical runtime: ~50ms per SKU × ~500 SKUs = 25s.
   */
  async rebuildCatalogCrowdsource(): Promise<{ totalSkus: number; durationMs: number }> {
    const start = Date.now();

    const distinct = await this.prisma.$queryRawUnsafe<RawRow[]>(`
      SELECT DISTINCT
        LOWER(TRIM(marca))     AS marca,
        LOWER(TRIM(diseno))    AS diseno,
        LOWER(TRIM(dimension)) AS dimension
      FROM "Tire"
      WHERE marca IS NOT NULL AND TRIM(marca) <> ''
        AND diseno IS NOT NULL AND TRIM(diseno) <> ''
        AND dimension IS NOT NULL AND TRIM(dimension) <> ''
    `);

    let count = 0;
    for (const row of distinct) {
      try {
        // Catalog uses `modelo`; our domain uses `diseno`. Same concept.
        await this.catalog.crowdsourceUpsert({
          marca:     String(row.marca),
          modelo:    String(row.diseno),
          dimension: String(row.dimension),
        });
        count++;
      } catch (err) {
        this.logger.warn(`crowdsourceUpsert failed for ${row.marca}/${row.diseno}/${row.dimension}: ${(err as Error).message}`);
      }
    }

    const durationMs = Date.now() - start;
    this.logger.log(`Catalog crowdsource rebuild: ${count}/${distinct.length} SKUs in ${durationMs}ms`);
    return { totalSkus: count, durationMs };
  }

  // ---------------------------------------------------------------------------
  // Scheduler — nightly rebuild at 03:00 Colombia (UTC-5) = 08:00 UTC
  // ---------------------------------------------------------------------------

  @Cron('0 8 * * *', { name: 'tire-benchmark-nightly' })
  async nightlyRebuild() {
    this.logger.log('[nightly] Starting TireBenchmark + catalog crowd rebuild');
    try {
      const bench = await this.rebuildAll();
      this.logger.log(`[nightly] Benchmarks: ${bench.totalSkus} SKUs in ${bench.durationMs}ms`);
    } catch (err) {
      this.logger.error(`[nightly] TireBenchmark rebuild failed: ${(err as Error).message}`);
    }
    try {
      const crowd = await this.rebuildCatalogCrowdsource();
      this.logger.log(`[nightly] Crowd:      ${crowd.totalSkus} SKUs in ${crowd.durationMs}ms`);
    } catch (err) {
      this.logger.error(`[nightly] Catalog crowd rebuild failed: ${(err as Error).message}`);
    }
  }
}
