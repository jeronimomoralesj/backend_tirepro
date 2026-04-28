/* eslint-disable */
/**
 * Recompute every inspection's CPK for Adispetrol SA using the updated
 * calcCpkMetrics (km floor = 100). Fixes "just-mounted" tires whose
 * stored inspections baked in an absurd cpk from km = 0.3 km.
 */

const path = require('path');
const DIST = path.resolve(__dirname, '..', 'dist');
const { NestFactory }   = require('@nestjs/core');
const { AppModule }     = require(path.join(DIST, 'app.module'));
const { PrismaService } = require(path.join(DIST, 'prisma/prisma.service'));
const { TireService }   = require(path.join(DIST, 'tires/tire.service'));

const COMPANY_ID = '9f958ac8-39a3-4012-9695-a2e96ae9aee9';
const LIMITE_LEGAL_MM = 2;
const MIN_MEANINGFUL_KM = 100;
const EXPECTED_KM = 80_000;

function calcCpk(totalCost, km, meses, profInicial, minDepth) {
  const usable = Math.max(profInicial - LIMITE_LEGAL_MM, 0);
  const mmWorn = Math.max(profInicial - minDepth, 0);
  const mmLeft = Math.max(minDepth - LIMITE_LEGAL_MM, 0);

  let projectedKm = 0;
  if (usable > 0) {
    if (km > 0) {
      const wear = mmWorn > 0 ? km + (km / mmWorn) * mmLeft : 0;
      const fallback = km + (mmLeft / usable) * EXPECTED_KM;
      if (mmWorn <= 0) projectedKm = fallback;
      else {
        const conf = Math.min(mmWorn / usable, 1);
        projectedKm = wear * conf + fallback * (1 - conf);
      }
    } else {
      projectedKm = EXPECTED_KM;
    }
  }
  projectedKm = Math.round(projectedKm);

  let cpk = 0;
  if (km >= MIN_MEANINGFUL_KM) cpk = totalCost / km;
  else if (projectedKm > 0 && totalCost > 0) cpk = totalCost / projectedKm;

  const cpkProy = projectedKm > 0 ? totalCost / projectedKm : 0;
  const cpt     = meses > 0 ? totalCost / meses : 0;
  const cptProy = projectedKm > 0 ? totalCost / (projectedKm / 6000) : 0;
  return { cpk, cpkProy, cpt, cptProy, projectedKm };
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  const prisma = app.get(PrismaService);
  const tires  = app.get(TireService);

  const all = await prisma.tire.findMany({
    where: { companyId: COMPANY_ID },
    select: {
      id: true, profundidadInicial: true, kilometrosRecorridos: true,
      costos: { select: { valor: true, fecha: true }, orderBy: { fecha: 'asc' } },
      inspecciones: { orderBy: { fecha: 'asc' } },
    },
  });
  console.log(`Recomputing ${all.length} tires' inspections...`);

  let inspUpdates = 0;
  let tireRefreshed = 0;

  for (const t of all) {
    if (!t.inspecciones.length) continue;
    for (const insp of t.inspecciones) {
      const costToDate = t.costos
        .filter(c => c.fecha <= insp.fecha)
        .reduce((s, c) => s + c.valor, 0);
      const minDepth = Math.min(insp.profundidadInt, insp.profundidadCen, insp.profundidadExt);
      const km = insp.kilometrosEstimados ?? 0;
      const m = calcCpk(costToDate, km, insp.mesesEnUso ?? 1, t.profundidadInicial, minDepth);

      await prisma.inspeccion.update({
        where: { id: insp.id },
        data: {
          cpk: m.cpk,
          cpkProyectado: m.cpkProy,
          cpt: m.cpt,
          cptProyectado: m.cptProy,
          kmProyectado: m.projectedKm,
        },
      });
      inspUpdates++;
    }
    // Refresh tire-level analytics from the updated inspections
    try {
      await tires.refreshTireAnalyticsCache(t.id);
      tireRefreshed++;
    } catch (e) { /* non-fatal */ }

    if (tireRefreshed % 100 === 0) {
      process.stdout.write(`\r  ${tireRefreshed}/${all.length} tires, ${inspUpdates} insp updates`);
    }
  }
  console.log(`\n  Done: ${tireRefreshed}/${all.length} tires refreshed, ${inspUpdates} insp updates`);

  // Distribution after fix
  const buckets = await Promise.all([
    prisma.tire.count({ where: { companyId: COMPANY_ID, currentCpk: { gt: 0, lte: 20 } } }),
    prisma.tire.count({ where: { companyId: COMPANY_ID, currentCpk: { gt: 20, lte: 100 } } }),
    prisma.tire.count({ where: { companyId: COMPANY_ID, currentCpk: { gt: 100, lte: 500 } } }),
    prisma.tire.count({ where: { companyId: COMPANY_ID, currentCpk: { gt: 500 } } }),
    prisma.tire.count({ where: { companyId: COMPANY_ID, currentCpk: null } }),
  ]);
  console.log('\nCPK distribution AFTER recompute:');
  console.log(`  0–20:     ${buckets[0]}`);
  console.log(`  20–100:   ${buckets[1]}`);
  console.log(`  100–500:  ${buckets[2]}`);
  console.log(`  > 500:    ${buckets[3]}`);
  console.log(`  null:     ${buckets[4]}`);

  await app.close();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
