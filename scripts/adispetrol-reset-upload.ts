/**
 * One-shot: delete all tires for Adispetrol SA and bulk-upload from
 * /tmp/adispetrol_bulk_ready.xlsx.
 *
 *   npx tsx scripts/adispetrol-reset-upload.ts
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TireService } from '../src/tires/tire.service';
import * as fs from 'fs';

const COMPANY_ID = '9f958ac8-39a3-4012-9695-a2e96ae9aee9';
const FILE_PATH  = '/tmp/adispetrol_bulk_ready.xlsx';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
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

  // Purge any leftover BulkUploadSnapshot rows for this company so the
  // "undo last upload" endpoint can't try to restore now-deleted tires.
  await prisma.bulkUploadSnapshot.deleteMany({ where: { companyId: COMPANY_ID } }).catch(() => {});

  const buffer = fs.readFileSync(FILE_PATH);
  console.log(`\n→ Uploading ${FILE_PATH} (${buffer.length} bytes)...`);

  const result = await tires.bulkUploadTires(
    { buffer } as any,
    COMPANY_ID,
    { fileName: 'informacion actualizada remax (1) (1).xlsx', recordSnapshot: true },
  );

  const after = await prisma.tire.count({ where: { companyId: COMPANY_ID } });
  const withVehicle = await prisma.tire.count({ where: { companyId: COMPANY_ID, vehicleId: { not: null } } });
  const byVida = await prisma.tire.groupBy({
    by: ['vidaActual'],
    where: { companyId: COMPANY_ID },
    _count: true,
  });
  const vehicles = await prisma.vehicle.count({ where: { companyId: COMPANY_ID } });

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Upload result');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Tires before:        ${before}`);
  console.log(`  Tires deleted:       ${del.count}`);
  console.log(`  Tires after:         ${after}`);
  console.log(`  Tires mounted:       ${withVehicle}`);
  console.log(`  Vehicles (company):  ${vehicles}`);
  console.log(`  By vida:             ${byVida.map(r => `${r.vidaActual}=${r._count}`).join(', ')}`);

  const r = result as any;
  console.log(`  Errors:              ${r?.errors?.length ?? 0}`);
  console.log(`  Warnings:            ${r?.warnings?.length ?? 0}`);

  if (r?.errors?.length) {
    console.log('\n  First 10 errors:');
    r.errors.slice(0, 10).forEach((e: string) => console.log(`    - ${e}`));
  }
  if (r?.warnings?.length) {
    console.log('\n  First 10 warnings:');
    r.warnings.slice(0, 10).forEach((w: string) => console.log(`    - ${w}`));
    const warnTypes: Record<string, number> = {};
    for (const w of r.warnings) {
      const m = w.match(/Row \d+: ([^—]+)/);
      const key = m ? m[1].trim() : 'other';
      warnTypes[key] = (warnTypes[key] || 0) + 1;
    }
    console.log('\n  Warning summary:');
    Object.entries(warnTypes)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .forEach(([k, v]) => console.log(`    ${v.toString().padStart(4)}  ${k}`));
  }

  await app.close();
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
