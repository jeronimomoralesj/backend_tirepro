/* eslint-disable */
/**
 * One-shot: delete all tires for Adispetrol SA and bulk-upload from
 * /tmp/adispetrol_bulk_ready.xlsx.
 *
 *   node scripts/adispetrol-reset-upload.js
 *
 * Runs against the compiled dist/. Make sure `npm run build` ran first.
 */

const path = require('path');
const fs = require('fs');

const DIST = path.resolve(__dirname, '..', 'dist');

const { NestFactory } = require('@nestjs/core');
const { AppModule } = require(path.join(DIST, 'app.module'));
const { PrismaService } = require(path.join(DIST, 'prisma/prisma.service'));
const { TireService } = require(path.join(DIST, 'tires/tire.service'));

const COMPANY_ID = '9f958ac8-39a3-4012-9695-a2e96ae9aee9';
const FILE_PATH  = '/tmp/adispetrol_bulk_ready.xlsx';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });

  const prisma = app.get(PrismaService);
  const tires  = app.get(TireService);

  const company = await prisma.company.findUnique({
    where: { id: COMPANY_ID },
    select: { id: true, name: true },
  });
  if (!company) throw new Error(`Company ${COMPANY_ID} not found`);

  const before = await prisma.tire.count({ where: { companyId: COMPANY_ID } });
  console.log(`\n→ Company: ${company.name} (${company.id})`);
  console.log(`  Tires before: ${before}`);

  console.log('\n→ Deleting all tires (cascades to inspecciones, costos, eventos, snapshots)...');
  const del = await prisma.tire.deleteMany({ where: { companyId: COMPANY_ID } });
  console.log(`  Deleted ${del.count} tires`);

  try {
    await prisma.bulkUploadSnapshot.deleteMany({ where: { companyId: COMPANY_ID } });
  } catch {}

  const buffer = fs.readFileSync(FILE_PATH);
  console.log(`\n→ Uploading ${FILE_PATH} (${buffer.length} bytes)...`);
  const t0 = Date.now();

  const result = await tires.bulkUploadTires(
    { buffer },
    COMPANY_ID,
    { fileName: 'informacion actualizada remax (1) (1).xlsx', recordSnapshot: true },
  );

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const after = await prisma.tire.count({ where: { companyId: COMPANY_ID } });
  const withVehicle = await prisma.tire.count({
    where: { companyId: COMPANY_ID, vehicleId: { not: null } },
  });
  const byVida = await prisma.tire.groupBy({
    by: ['vidaActual'],
    where: { companyId: COMPANY_ID },
    _count: true,
  });
  const vehicles = await prisma.vehicle.count({ where: { companyId: COMPANY_ID } });

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  Upload result  —  ${elapsed}s`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Tires before:        ${before}`);
  console.log(`  Tires deleted:       ${del.count}`);
  console.log(`  Tires after:         ${after}`);
  console.log(`  Tires mounted:       ${withVehicle}`);
  console.log(`  Vehicles (company):  ${vehicles}`);
  console.log(`  By vida:             ${byVida.map(r => `${r.vidaActual}=${r._count}`).join(', ')}`);

  const errors   = (result && result.errors)   || [];
  const warnings = (result && result.warnings) || [];
  console.log(`  Errors:              ${errors.length}`);
  console.log(`  Warnings:            ${warnings.length}`);

  if (errors.length) {
    console.log('\n  First 15 errors:');
    errors.slice(0, 15).forEach(e => console.log(`    - ${e}`));
  }
  if (warnings.length) {
    const warnTypes = {};
    for (const w of warnings) {
      const m = w.match(/Row \d+:\s*([^—\-]+)/);
      const key = m ? m[1].trim() : 'other';
      warnTypes[key] = (warnTypes[key] || 0) + 1;
    }
    console.log('\n  Warning categories:');
    Object.entries(warnTypes)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .forEach(([k, v]) => console.log(`    ${String(v).padStart(5)}  ${k}`));
  }

  await app.close();
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
