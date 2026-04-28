/**
 * Read-only audit: check CARGOLAP inspections on 2026-04-25.
 *
 *   npx ts-node scripts/cargolap-audit-april25.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const COMPANY_ID = 'dfe8cb65-ab81-4d00-b410-12f94280c7e0';
const DAY = '2026-04-25';

async function main() {
  const start = new Date(`${DAY}T00:00:00.000Z`);
  const end = new Date(`${DAY}T23:59:59.999Z`);

  // Day window in UTC
  const inspsUtc: any[] = await prisma.$queryRaw`
    SELECT i.id, i.fecha, i."tireId", i."externalSourceId",
           i."kmActualVehiculo", i."profundidadInt", i."profundidadCen",
           i."profundidadExt", i.source, i."createdAt",
           t.placa AS tire_placa, t."companyId",
           v.placa AS vehicle_placa,
           i."sourceMetadata"
      FROM inspecciones i
      JOIN "Tire" t ON t.id = i."tireId"
      LEFT JOIN "Vehicle" v ON v.id = t."vehicleId"
     WHERE t."companyId" = ${COMPANY_ID}
       AND i.fecha >= ${start}
       AND i.fecha <= ${end}
     ORDER BY i.fecha ASC, i."createdAt" ASC`;

  // Also Bogotá local day (UTC-5) — Excel date strings often are local
  const startBog = new Date(`${DAY}T05:00:00.000Z`);
  const endBog = new Date(`2026-04-26T04:59:59.999Z`);
  const inspsBog: any[] = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS c
      FROM inspecciones i
      JOIN "Tire" t ON t.id = i."tireId"
     WHERE t."companyId" = ${COMPANY_ID}
       AND i.fecha >= ${startBog}
       AND i.fecha <= ${endBog}`;

  // createdAt window — captures rows possibly inserted on Apr 25 even if
  // the Excel "fecha" was different.
  const createdRows: any[] = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS c, MIN(i."createdAt") mn, MAX(i."createdAt") mx
      FROM inspecciones i
      JOIN "Tire" t ON t.id = i."tireId"
     WHERE t."companyId" = ${COMPANY_ID}
       AND i."createdAt" >= ${start}
       AND i."createdAt" <= ${end}`;

  // Daily counts around April 25 for context
  const window: any[] = await prisma.$queryRaw`
    SELECT DATE(i.fecha) AS d, COUNT(*)::int AS c
      FROM inspecciones i
      JOIN "Tire" t ON t.id = i."tireId"
     WHERE t."companyId" = ${COMPANY_ID}
       AND i.fecha >= '2026-04-20'::date
       AND i.fecha <  '2026-05-01'::date
     GROUP BY DATE(i.fecha)
     ORDER BY DATE(i.fecha)`;

  // Source breakdown for the day (UTC)
  const bySource: any[] = await prisma.$queryRaw`
    SELECT i.source::text AS src, COUNT(*)::int AS c
      FROM inspecciones i
      JOIN "Tire" t ON t.id = i."tireId"
     WHERE t."companyId" = ${COMPANY_ID}
       AND i.fecha >= ${start}
       AND i.fecha <= ${end}
     GROUP BY i.source::text
     ORDER BY c DESC`;

  // externalSourceId patterns for the day — to detect replay/migration tags
  const byTag: any[] = await prisma.$queryRaw`
    SELECT split_part(COALESCE(i."externalSourceId",'(none)'), ':', 1) AS tag,
           COUNT(*)::int AS c
      FROM inspecciones i
      JOIN "Tire" t ON t.id = i."tireId"
     WHERE t."companyId" = ${COMPANY_ID}
       AND i.fecha >= ${start}
       AND i.fecha <= ${end}
     GROUP BY 1
     ORDER BY c DESC`;

  // Total counts (sanity)
  const totals: any[] = await prisma.$queryRaw`
    SELECT
      (SELECT COUNT(*)::int FROM "Tire" WHERE "companyId"=${COMPANY_ID}) AS tires,
      (SELECT COUNT(*)::int FROM "Vehicle" WHERE "companyId"=${COMPANY_ID}) AS vehicles,
      (SELECT COUNT(*)::int
         FROM inspecciones i JOIN "Tire" t ON t.id=i."tireId"
        WHERE t."companyId"=${COMPANY_ID}) AS inspections_total`;

  console.log('=== CARGOLAP audit — focal day:', DAY, '===');
  console.log('Company totals     :', totals[0]);
  console.log();
  console.log('Inspections with fecha on 2026-04-25 (UTC day) :', inspsUtc.length);
  console.log('Inspections with fecha on 2026-04-25 (Bogotá day, UTC-5):', inspsBog[0].c);
  console.log('Inspections with createdAt on 2026-04-25 (UTC) :', createdRows[0]);
  console.log();
  console.log('Daily fecha counts (Apr 20–30):');
  for (const r of window) {
    const dStr = r.d instanceof Date ? r.d.toISOString().slice(0, 10) : String(r.d).slice(0, 10);
    console.log(`  ${dStr}  ${r.c}`);
  }
  console.log();
  console.log('Source breakdown (Apr 25 UTC day):');
  for (const r of bySource) console.log(`  ${r.src.padEnd(20)} ${r.c}`);
  console.log();
  console.log('externalSourceId tag breakdown (Apr 25 UTC day):');
  for (const r of byTag) console.log(`  ${String(r.tag).padEnd(30)} ${r.c}`);
  console.log();

  // First 20 sample rows
  console.log('Sample rows (up to 20):');
  for (const r of inspsUtc.slice(0, 20)) {
    console.log(
      `  ${r.id.slice(0, 8)} fecha=${r.fecha.toISOString()} ` +
        `tire=${r.tire_placa ?? '?'} vehicle=${r.vehicle_placa ?? '?'} ` +
        `km=${r.kmActualVehiculo ?? '-'} ` +
        `mm=(${r.profundidadInt}/${r.profundidadCen}/${r.profundidadExt}) ` +
        `src=${r.source} tag=${r.externalSourceId ?? '(none)'}`,
    );
  }

  // Distinct tires touched on that fecha day (UTC)
  const tiresTouched: any[] = await prisma.$queryRaw`
    SELECT COUNT(DISTINCT i."tireId")::int AS c
      FROM inspecciones i JOIN "Tire" t ON t.id=i."tireId"
     WHERE t."companyId"=${COMPANY_ID}
       AND i.fecha >= ${start} AND i.fecha <= ${end}`;
  console.log('\nDistinct tires inspected on UTC 2026-04-25:', tiresTouched[0].c);

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
