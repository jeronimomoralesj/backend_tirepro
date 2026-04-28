/* eslint-disable */
/**
 * Post-upload cleanup for Adispetrol SA:
 *   1. Delete Merquepro ghost tires (tires with externalSourceId starting
 *      with "merquepro:" — duplicates of rows we just loaded from the Excel).
 *   2. Delete ghost vehicles whose placas are not in the Excel AND that
 *      have no tires after the ghost-tire delete.
 *   3. Re-run refreshTireAnalyticsCache on every remaining tire so the
 *      tightened calcCpkMetrics (km floor = 100) kicks in and the absurd
 *      "just mounted" CPK values get recomputed with projectedKm.
 */

const path = require('path');
const DIST = path.resolve(__dirname, '..', 'dist');
const { NestFactory } = require('@nestjs/core');
const { AppModule }     = require(path.join(DIST, 'app.module'));
const { PrismaService } = require(path.join(DIST, 'prisma/prisma.service'));
const { TireService }   = require(path.join(DIST, 'tires/tire.service'));

const COMPANY_ID = '9f958ac8-39a3-4012-9695-a2e96ae9aee9';
const XLSX = require('xlsx');
const EXCEL_PATH = '/Users/jeronimo/Downloads/informacion actualizada remax (1) (1).xlsx';

async function main() {
  const app    = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  const prisma = app.get(PrismaService);
  const tires  = app.get(TireService);

  const wb = XLSX.readFile(EXCEL_PATH);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { raw: false, defval: '' });
  const excelPlacas = new Set(
    rows.map(r => String(r['PLACA'] ?? '').trim().toLowerCase()).filter(Boolean),
  );
  console.log(`Excel has ${excelPlacas.size} unique placas`);

  // ── 1. Delete ghost tires ────────────────────────────────────────────────
  const ghostWhere = {
    companyId: COMPANY_ID,
    externalSourceId: { startsWith: 'merquepro:' },
  };
  const ghostCount = await prisma.tire.count({ where: ghostWhere });
  console.log(`\nDeleting ${ghostCount} Merquepro ghost tires...`);
  const del = await prisma.tire.deleteMany({ where: ghostWhere });
  console.log(`  Deleted ${del.count}`);

  // ── 2. Delete ghost vehicles not in Excel AND with no tires ──────────────
  const allVehicles = await prisma.vehicle.findMany({
    where: { companyId: COMPANY_ID },
    select: { id: true, placa: true, _count: { select: { tires: true } } },
  });
  const orphanVehicles = allVehicles.filter(
    v => !excelPlacas.has((v.placa ?? '').toLowerCase()) && v._count.tires === 0,
  );
  console.log(`\nOrphan vehicles (not in Excel, 0 tires): ${orphanVehicles.length}`);
  if (orphanVehicles.length) {
    const vDel = await prisma.vehicle.deleteMany({
      where: { id: { in: orphanVehicles.map(v => v.id) } },
    });
    console.log(`  Deleted ${vDel.count} vehicles`);
  }

  // ── 3. Recompute CPKs on every surviving tire ────────────────────────────
  const survivors = await prisma.tire.findMany({
    where: { companyId: COMPANY_ID },
    select: { id: true },
  });
  console.log(`\nRefreshing analytics for ${survivors.length} tires...`);

  const CONCURRENCY = 6;
  let ok = 0, fail = 0;
  for (let i = 0; i < survivors.length; i += CONCURRENCY) {
    const chunk = survivors.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map(t => tires.refreshTireAnalyticsCache(t.id)),
    );
    for (const r of results) r.status === 'fulfilled' ? ok++ : fail++;
    if ((i + chunk.length) % 120 === 0 || i + chunk.length === survivors.length) {
      process.stdout.write(`\r  ${i + chunk.length}/${survivors.length} (ok=${ok}, fail=${fail})`);
    }
  }
  console.log('');

  // ── Final state ──────────────────────────────────────────────────────────
  const [total, bad, good, nullCpk] = await Promise.all([
    prisma.tire.count({ where: { companyId: COMPANY_ID } }),
    prisma.tire.count({ where: { companyId: COMPANY_ID, currentCpk: { gt: 500 } } }),
    prisma.tire.count({ where: { companyId: COMPANY_ID, currentCpk: { gt: 0, lte: 500 } } }),
    prisma.tire.count({ where: { companyId: COMPANY_ID, currentCpk: null } }),
  ]);

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Post-cleanup state');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Total tires:          ${total}`);
  console.log(`  CPK 0–500 (sane):     ${good}`);
  console.log(`  CPK > 500 (suspect):  ${bad}`);
  console.log(`  CPK null:             ${nullCpk}`);

  await app.close();
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
