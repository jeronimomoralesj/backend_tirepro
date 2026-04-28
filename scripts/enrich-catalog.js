/* eslint-disable */
/**
 * Backfill the tire_master_catalog with what we can derive cheaply:
 *
 *   1. Parse the `dimension` string into anchoMm / perfil / rin /
 *      construccion — handles metric ("295/80R22.5"), truck/imperial
 *      ("12R22.5") and LT ("LT245/75R16") forms.
 *   2. Pull `rtdMm` from the crowd average of Tire.profundidadInicial
 *      when we have enough observations for the same (marca, modelo,
 *      dimension) group.
 *
 * Does not touch rows where the field is already set. Leaves a report
 * of everything still missing after the pass so we can plan the next
 * enrichment (scraper, manual curation, etc.).
 */

const { PrismaClient } = require('/Users/jeronimo/Desktop/TirePro/backend_tirepro/node_modules/@prisma/client');
const p = new PrismaClient();

// ════════════════════════════════════════════════════════════════════════
// Dimension parser
// ════════════════════════════════════════════════════════════════════════

// Common constructions — R=Radial, B=Bias-belted, D=Diagonal
const CONSTRUCTION_BY_LETTER = { R: 'Radial', B: 'Bias', D: 'Diagonal' };

function parseDimension(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toUpperCase().replace(/\s+/g, ' ');

  // Metric: 295/80R22.5, 295/80 R 22.5, LT245/75R16, 205/55ZR16
  let m = s.match(/^(?:LT|ST|P)?\s*(\d{2,3})\/(\d{1,2})\s*(Z?)\s*([RBD])\s*(\d{1,2}(?:\.\d+)?)$/);
  if (m) {
    return {
      anchoMm: parseFloat(m[1]),
      perfil:  m[2],
      construccion: CONSTRUCTION_BY_LETTER[m[4]] ?? null,
      rin:     m[5],
    };
  }

  // Truck / imperial: 12R22.5, 11R24.5, 8.25R16
  m = s.match(/^(\d{1,2}(?:\.\d+)?)\s*([RBD])\s*(\d{1,2}(?:\.\d+)?)$/);
  if (m) {
    return {
      // 12R22.5 — the first number is width in inches. Convert to mm for a
      // consistent anchoMm column. 1 inch = 25.4 mm.
      anchoMm: Math.round(parseFloat(m[1]) * 25.4 * 10) / 10,
      perfil:  'R', // truck-style tires don't have a perfil ratio; mirror prior seed data
      construccion: CONSTRUCTION_BY_LETTER[m[2]] ?? null,
      rin:     m[3],
    };
  }

  return null;
}

// ════════════════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════════════════

async function main() {
  const skus = await p.tireMasterCatalog.findMany({
    select: {
      id: true, marca: true, modelo: true, dimension: true,
      anchoMm: true, perfil: true, rin: true, construccion: true, rtdMm: true,
    },
  });
  console.log(`Total SKUs: ${skus.length}`);

  let dimParsed = 0, dimSkipped = 0;
  const dimUpdates = [];

  for (const sku of skus) {
    const parsed = parseDimension(sku.dimension);
    if (!parsed) { dimSkipped++; continue; }

    const patch = {};
    if (sku.anchoMm      == null && parsed.anchoMm      != null) patch.anchoMm      = parsed.anchoMm;
    if (sku.perfil       == null && parsed.perfil       != null) patch.perfil       = parsed.perfil;
    if (sku.rin          == null && parsed.rin          != null) patch.rin          = parsed.rin;
    if (sku.construccion == null && parsed.construccion != null) patch.construccion = parsed.construccion;
    if (Object.keys(patch).length > 0) {
      dimUpdates.push({ id: sku.id, patch });
    }
  }
  console.log(`Dimension parser — will fill ${dimUpdates.length} SKUs, unparseable: ${dimSkipped}`);

  // Batch update
  for (const u of dimUpdates) {
    await p.tireMasterCatalog.update({ where: { id: u.id }, data: u.patch });
    dimParsed++;
    if (dimParsed % 500 === 0) process.stdout.write(`\r  dim: ${dimParsed}/${dimUpdates.length}`);
  }
  console.log(`\nDimension fields backfilled on ${dimParsed} SKUs`);

  // ────────────────────────────────────────────────────────────────────
  // rtdMm backfill from Tire.profundidadInicial crowd average
  // ────────────────────────────────────────────────────────────────────
  const crowd = await p.$queryRaw`
    SELECT
      LOWER(TRIM(marca))     AS marca,
      LOWER(TRIM(diseno))    AS modelo,
      LOWER(TRIM(dimension)) AS dimension,
      ROUND(AVG("profundidadInicial")::numeric, 1) AS avg_rtd,
      COUNT(*)::int AS n
    FROM "Tire"
    WHERE "profundidadInicial" > 10 AND "profundidadInicial" < 40
    GROUP BY 1, 2, 3
    HAVING COUNT(*) >= 3`;

  console.log(`\nCrowd groups with ≥3 tires: ${crowd.length}`);
  let rtdFilled = 0;
  for (const row of crowd) {
    const sku = await p.tireMasterCatalog.findFirst({
      where: {
        marca:     { equals: row.marca,     mode: 'insensitive' },
        modelo:    { equals: row.modelo,    mode: 'insensitive' },
        dimension: { equals: row.dimension, mode: 'insensitive' },
      },
      select: { id: true, rtdMm: true },
    });
    if (!sku || sku.rtdMm != null) continue;
    await p.tireMasterCatalog.update({
      where: { id: sku.id },
      data:  { rtdMm: parseFloat(row.avg_rtd) },
    });
    rtdFilled++;
  }
  console.log(`rtdMm backfilled on ${rtdFilled} SKUs from crowd data`);

  // ────────────────────────────────────────────────────────────────────
  // Final report — what's still missing?
  // ────────────────────────────────────────────────────────────────────
  const report = await p.$queryRaw`
    SELECT
      COUNT(*)                                         AS total,
      COUNT(*) FILTER (WHERE "anchoMm"         IS NULL) AS missing_ancho,
      COUNT(*) FILTER (WHERE "perfil"          IS NULL) AS missing_perfil,
      COUNT(*) FILTER (WHERE "rin"             IS NULL) AS missing_rin,
      COUNT(*) FILTER (WHERE "construccion"    IS NULL) AS missing_construccion,
      COUNT(*) FILTER (WHERE "rtdMm"           IS NULL) AS missing_rtd,
      COUNT(*) FILTER (WHERE "indiceCarga"     IS NULL) AS missing_load,
      COUNT(*) FILTER (WHERE "indiceVelocidad" IS NULL) AS missing_speed,
      COUNT(*) FILTER (WHERE "psiRecomendado"  IS NULL) AS missing_psi,
      COUNT(*) FILTER (WHERE "pesoKg"          IS NULL) AS missing_peso
    FROM tire_master_catalog`;
  console.log('\nPost-enrichment gaps:');
  for (const k in report[0]) console.log(`  ${k.padEnd(22)} ${report[0][k]}`);

  await p.$disconnect();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
