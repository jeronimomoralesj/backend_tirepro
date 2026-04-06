/**
 * seed-benchmarks.ts
 *
 * Reads ~/TirePro/master.xlsx ("Base de Datos Maestra" sheet) and upserts
 * TireBenchmark records grouped by (marca, diseno, dimension).
 *
 * Run:  npx ts-node scripts/seed-benchmarks.ts
 */

import * as path from 'path';
import * as XLSX from 'xlsx';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const EXCEL_PATH = path.resolve(__dirname, '../../master.xlsx');
const SHEET_NAME = 'Base de Datos Maestra';

// Column indices (0-based) from row 2 headers
const COL = {
  MARCA:      0,   // "Marca"
  MODELO:     1,   // "Modelo / Banda"
  DIMENSION:  2,   // "Dimensión"
  RTD_MM:     11,  // "RTD (mm)" — initial tread depth
  PSI_REC:    14,  // "PSI Rec."
  KM_REALES:  16,  // "Km Est. Reales"
  REENC:      18,  // "Reenc." — "Si" / "No"
  VIDAS_REENC:19,  // "Vidas Reenc." — number
  PRECIO:     20,  // "Precio (COP)"
  SEGMENTO:   21,  // "Segmento"
};

interface GroupData {
  marca: string;
  diseno: string;
  dimension: string;
  prices: number[];
  kmReales: number[];
  rtdMm: number[];
  reencCount: number;
  vidasReenc: number[];
  sampleSize: number;
}

function clean(val: unknown): string {
  if (val == null) return '';
  return String(val).trim();
}

function num(val: unknown): number | null {
  if (val == null) return null;
  const n = typeof val === 'number' ? val : parseFloat(String(val).replace(/[,$\s]/g, ''));
  return isNaN(n) ? null : n;
}

function avg(arr: number[]): number | null {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

async function main() {
  console.log(`Reading ${EXCEL_PATH} ...`);

  const wb = XLSX.readFile(EXCEL_PATH);
  const ws = wb.Sheets[SHEET_NAME];
  if (!ws) {
    console.error(`Sheet "${SHEET_NAME}" not found. Available: ${wb.SheetNames.join(', ')}`);
    process.exit(1);
  }

  // Read starting from row 2 (0-indexed row 1) so row[0] = headers, row[1+] = data
  const rows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, range: 1 });
  const headers = rows[0] as string[];
  const data = rows.slice(1);

  console.log(`Headers: ${headers.length} columns`);
  console.log(`Data rows: ${data.length}`);

  // Group by (marca, modelo, dimension)
  const groups = new Map<string, GroupData>();
  let skipped = 0;

  for (const row of data) {
    const r = row as unknown[];
    const marca     = clean(r[COL.MARCA]);
    const modelo    = clean(r[COL.MODELO]);
    const dimension = clean(r[COL.DIMENSION]);

    if (!marca || !modelo || !dimension) {
      skipped++;
      continue;
    }

    const key = `${marca.toLowerCase()}|${modelo.toLowerCase()}|${dimension.toLowerCase()}`;

    if (!groups.has(key)) {
      groups.set(key, {
        marca, diseno: modelo, dimension,
        prices: [], kmReales: [], rtdMm: [],
        reencCount: 0, vidasReenc: [], sampleSize: 0,
      });
    }

    const g = groups.get(key)!;
    g.sampleSize++;

    const price = num(r[COL.PRECIO]);
    if (price && price > 0) g.prices.push(price);

    const km = num(r[COL.KM_REALES]);
    if (km && km > 0) g.kmReales.push(km);

    const rtd = num(r[COL.RTD_MM]);
    if (rtd && rtd > 0) g.rtdMm.push(rtd);

    const reenc = clean(r[COL.REENC]).toLowerCase();
    if (reenc === 'si' || reenc === 'sí') g.reencCount++;

    const vidasR = num(r[COL.VIDAS_REENC]);
    if (vidasR && vidasR > 0) g.vidasReenc.push(vidasR);
  }

  console.log(`Grouped into ${groups.size} unique (marca, diseno, dimension) combos`);
  console.log(`Skipped ${skipped} rows with missing marca/modelo/dimension`);

  // Upsert benchmarks
  let upserted = 0;
  let errors = 0;

  for (const g of groups.values()) {
    try {
      const precioPromedio = avg(g.prices);
      const precioMin = g.prices.length ? Math.min(...g.prices) : null;
      const precioMax = g.prices.length ? Math.max(...g.prices) : null;
      const avgKmPorVida = avg(g.kmReales);
      const avgMmDesgaste = avg(g.rtdMm); // initial RTD as proxy for wear capacity

      await prisma.tireBenchmark.upsert({
        where: {
          marca_diseno_dimension: {
            marca: g.marca,
            diseno: g.diseno,
            dimension: g.dimension,
          },
        },
        update: {
          sampleSize: g.sampleSize,
          precioPromedio,
          precioMin,
          precioMax,
          avgKmPorVida,
          avgMmDesgaste,
        },
        create: {
          marca: g.marca,
          diseno: g.diseno,
          dimension: g.dimension,
          sampleSize: g.sampleSize,
          precioPromedio,
          precioMin,
          precioMax,
          avgKmPorVida,
          avgMmDesgaste,
        },
      });

      upserted++;
      if (upserted % 50 === 0) {
        console.log(`  ... upserted ${upserted} / ${groups.size}`);
      }
    } catch (err: any) {
      errors++;
      console.error(`  Error upserting ${g.marca} ${g.diseno} ${g.dimension}: ${err.message}`);
    }
  }

  console.log(`\nDone.`);
  console.log(`  Upserted: ${upserted}`);
  console.log(`  Errors:   ${errors}`);
  console.log(`  Total benchmarks in DB: ${await prisma.tireBenchmark.count()}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  prisma.$disconnect();
  process.exit(1);
});
