/**
 * Seeds the default Reencauche inventory bucket for every existing company.
 * The service's findAll() already lazy-creates it on first read, but this
 * script ensures it exists up-front so the bucket is available before any
 * bucket fetch fires.
 *
 * Usage:
 *   npx ts-node scripts/seed-default-buckets.ts [--apply]
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

const DEFAULT_BUCKETS = [
  { nombre: 'Reencauche', color: '#8b5cf6', icono: '♻️' },
];

async function main() {
  const companies = await prisma.company.findMany({ select: { id: true, name: true } });
  console.log(`Scanning ${companies.length} companies…`);

  let created = 0;
  let skipped = 0;
  const details: Array<{ company: string; nombre: string; action: string }> = [];

  for (const c of companies) {
    for (const defBucket of DEFAULT_BUCKETS) {
      const exists = await prisma.tireInventoryBucket.findFirst({
        where: {
          companyId: c.id,
          nombre: { equals: defBucket.nombre, mode: 'insensitive' },
        },
      });
      if (exists) {
        skipped++;
        continue;
      }
      created++;
      if (details.length < 20) {
        details.push({ company: c.name, nombre: defBucket.nombre, action: 'create' });
      }
      if (APPLY) {
        await prisma.tireInventoryBucket.create({
          data: {
            companyId: c.id,
            nombre: defBucket.nombre,
            color:  defBucket.color,
            icono:  defBucket.icono,
          },
        });
      }
    }
  }

  const bar = '─'.repeat(80);
  console.log(bar);
  console.log(`Will create: ${created}`);
  console.log(`Already exist: ${skipped}`);
  console.log(bar);
  for (const d of details) {
    console.log(`  ${d.action.padEnd(8)} ${d.nombre.padEnd(14)} · ${d.company}`);
  }
  console.log(bar);
  console.log(APPLY ? `✅ Applied.` : `Dry-run. Re-run with --apply to write.`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
