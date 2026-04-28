/* eslint-disable */
/**
 * Replace every tire cost for Adispetrol SA with a catalog-driven value:
 *   - reencauche tire → single cost of $650,000 (concepto = reencauche1)
 *   - nueva tire      → catalog precioCop for (marca + dimension), else
 *                       $1,900,000 fallback (concepto = compra_nueva)
 * Then recompute every inspection's cpk/cpkProy from the new cost and
 * update tire.currentCpk + lifetimeCpk in one SQL pass.
 */

const path = require('path');
const DIST = path.resolve(__dirname, '..', 'dist');
const { NestFactory }   = require('@nestjs/core');
const { AppModule }     = require(path.join(DIST, 'app.module'));
const { PrismaService } = require(path.join(DIST, 'prisma/prisma.service'));

const COMPANY_ID = '9f958ac8-39a3-4012-9695-a2e96ae9aee9';
const REENCAUCHE_COST = 650_000;
const FALLBACK_NEW    = 1_900_000;
const MIN_MEANINGFUL_KM = 5_000;

async function main() {
  const app    = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  const prisma = app.get(PrismaService);

  // ── 1. Fetch every tire + current lifetime km + inspections ──────────────
  const tires = await prisma.tire.findMany({
    where: { companyId: COMPANY_ID },
    select: {
      id: true, marca: true, dimension: true, vidaActual: true,
      kilometrosRecorridos: true,
      inspecciones: { select: { id: true, cpkProyectado: true, kmProyectado: true } },
    },
  });
  console.log(`Tires to reprice: ${tires.length}`);

  // ── 2. Batch catalog lookups (one row per marca+dimension) ───────────────
  const uniqueKeys = new Map();
  for (const t of tires) {
    if ((t.vidaActual || '').startsWith('reencauche')) continue;
    const key = `${(t.marca || '').trim().toLowerCase()}::${(t.dimension || '').trim().toLowerCase()}`;
    if (!uniqueKeys.has(key)) uniqueKeys.set(key, { marca: t.marca, dimension: t.dimension });
  }
  console.log(`Distinct (marca, dimension) pairs to price: ${uniqueKeys.size}`);

  const priceByKey = new Map();
  for (const [key, { marca, dimension }] of uniqueKeys) {
    const sku = await prisma.tireMasterCatalog.findFirst({
      where: {
        marca:     { equals: marca,     mode: 'insensitive' },
        dimension: { contains: dimension, mode: 'insensitive' },
        precioCop: { gt: 0 },
      },
      orderBy: { precioCop: { sort: 'asc', nulls: 'last' } },
      select:  { precioCop: true, modelo: true },
    });
    priceByKey.set(key, sku?.precioCop ?? null);
  }

  let nCatalog = 0, nFallback = 0, nReencauche = 0;

  // ── 3. Replace costs per tire ────────────────────────────────────────────
  console.log('\nRewriting costs...');
  const fechaCompra = new Date();
  for (let i = 0; i < tires.length; i++) {
    const t = tires[i];
    const isReenc = (t.vidaActual || '').startsWith('reencauche');

    // Wipe existing tire_costos so we don't duplicate $1.9M fallbacks.
    await prisma.tireCosto.deleteMany({ where: { tireId: t.id } });

    let valor, concepto;
    if (isReenc) {
      valor = REENCAUCHE_COST; concepto = 'reencauche1'; nReencauche++;
    } else {
      const key = `${(t.marca || '').trim().toLowerCase()}::${(t.dimension || '').trim().toLowerCase()}`;
      const cat = priceByKey.get(key);
      if (cat && cat > 0) { valor = cat; nCatalog++; }
      else                 { valor = FALLBACK_NEW; nFallback++; }
      concepto = 'compra_nueva';
    }

    await prisma.tireCosto.create({
      data: { tireId: t.id, valor, fecha: fechaCompra, concepto },
    });

    if ((i + 1) % 100 === 0) process.stdout.write(`\r  ${i + 1}/${tires.length}`);
  }
  console.log(`\n  Done. catalog=${nCatalog}, fallback=${nFallback}, reencauche=${nReencauche}`);

  // ── 4. Recompute every inspection's cpk + tire.currentCpk/lifetimeCpk ────
  // SQL version — single query recomputes cpk from the one-and-only new cost.
  console.log('\nRecomputing inspection + tire CPKs...');

  // Update inspection cpkProyectado and cpk. cpkProyectado = cost/kmProyectado.
  // cpk = cost/kilometrosEstimados when that km is meaningful, else = cpkProyectado.
  const inspUpd = await prisma.$executeRaw`
    UPDATE inspecciones i
    SET "cpkProyectado" = CASE WHEN i."kmProyectado" > 0 THEN c.valor / i."kmProyectado" ELSE 0 END,
        cpk = CASE
          WHEN i."kilometrosEstimados" >= ${MIN_MEANINGFUL_KM} THEN c.valor / i."kilometrosEstimados"
          WHEN i."kmProyectado" > 0 THEN c.valor / i."kmProyectado"
          ELSE 0
        END
    FROM "Tire" t
    JOIN tire_costos c ON c."tireId" = t.id
    WHERE t."companyId" = ${COMPANY_ID}
      AND i."tireId" = t.id`;
  console.log(`  inspecciones updated: ${inspUpd}`);

  // lifetimeCpk = sum(cost) / kilometrosRecorridos (≥ 5k km) else null
  const lifeUpd = await prisma.$executeRaw`
    UPDATE "Tire" t
    SET "lifetimeCpk" = CASE
      WHEN t."kilometrosRecorridos" >= ${MIN_MEANINGFUL_KM}
        AND sub.total > 0 THEN ROUND((sub.total / t."kilometrosRecorridos")::numeric, 2)
      ELSE NULL END
    FROM (
      SELECT "tireId", SUM(valor) AS total
      FROM tire_costos
      GROUP BY "tireId"
    ) sub
    WHERE t."companyId" = ${COMPANY_ID}
      AND sub."tireId" = t.id`;
  console.log(`  lifetimeCpk updated: ${lifeUpd}`);

  // currentCpk = latest inspection's cpk
  const currUpd = await prisma.$executeRaw`
    UPDATE "Tire" t
    SET "currentCpk" = sub.cpk,
        "currentCpt" = sub.cpt,
        "lastInspeccionDate" = sub.fecha
    FROM (
      SELECT DISTINCT ON (t.id) t.id AS tid, i.cpk, i.cpt, i.fecha
      FROM "Tire" t
      JOIN inspecciones i ON i."tireId" = t.id
      WHERE t."companyId" = ${COMPANY_ID}
      ORDER BY t.id, i.fecha DESC
    ) sub
    WHERE t.id = sub.tid`;
  console.log(`  currentCpk updated: ${currUpd}`);

  // ── 5. Summary ───────────────────────────────────────────────────────────
  const avg = await prisma.tire.aggregate({
    where: { companyId: COMPANY_ID },
    _avg: { currentCpk: true, lifetimeCpk: true, kilometrosRecorridos: true },
    _max: { currentCpk: true },
  });
  console.log('\nPost-reprice:');
  console.log(`  avg km:          ${Math.round(avg._avg.kilometrosRecorridos || 0).toLocaleString()}`);
  console.log(`  avg currentCpk:  $${avg._avg.currentCpk?.toFixed(2) ?? 'n/a'}`);
  console.log(`  avg lifetimeCpk: $${avg._avg.lifetimeCpk?.toFixed(2) ?? 'n/a'}`);
  console.log(`  max currentCpk:  $${avg._max.currentCpk?.toFixed(0) ?? 'n/a'}`);

  const byMarca = await prisma.$queryRaw`
    SELECT marca, COUNT(*)::int AS n, ROUND(AVG("currentCpk")::numeric, 0) AS avg_cpk
    FROM "Tire"
    WHERE "companyId" = ${COMPANY_ID} AND "currentCpk" IS NOT NULL
    GROUP BY marca ORDER BY n DESC`;
  console.log('\nCPK by marca:');
  byMarca.forEach(r => console.log(`  ${r.marca.padEnd(14)} n=${String(r.n).padStart(4)}  avgCpk=$${r.avg_cpk}`));

  await app.close();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
