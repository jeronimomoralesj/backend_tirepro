/**
 * Backfills Tire.marca for every tire currently in a retread vida.
 *
 * Historically, updateVida set Tire.diseno = banda but left Tire.marca
 * pointing at the carcass brand. That misrepresents the real product on
 * the road — a Michelin carcass with a Contitread band is effectively a
 * Continental product once retreaded.
 *
 * Strategy:
 *   1. Prefer the bandaMarca recorded on the most recent TireVidaSnapshot
 *      (that snapshot was written when the tire entered its current vida,
 *      so its bandaMarca is the retread brand for the current life).
 *   2. Fall back to Tire.diseno — this matches the explicit request to
 *      "set both banda and brand to the same since we dont have the brand."
 *
 * Usage:
 *   DATABASE_URL=... npx ts-node scripts/backfill-retread-marca.ts [--apply]
 *
 * Without --apply the script prints a plan and exits without writing.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const RETREAD_VIDAS = ['reencauche1', 'reencauche2', 'reencauche3'] as const;
const APPLY = process.argv.includes('--apply');

async function main() {
  const tires = await prisma.tire.findMany({
    where: { vidaActual: { in: [...RETREAD_VIDAS] } },
    include: {
      vidaSnapshots: {
        orderBy: { fechaFin: 'desc' },
        take: 1,
        select: { bandaMarca: true, bandaNombre: true, vida: true, fechaFin: true },
      },
    },
  });

  console.log(`Found ${tires.length} tires in a retread vida.\n`);
  if (!tires.length) {
    console.log('Nothing to do.');
    return;
  }

  let willUpdate = 0;
  let alreadyCorrect = 0;
  let snapshotSource = 0;
  let disenoSource = 0;
  const preview: Array<{ id: string; placa: string; before: string; after: string; source: string }> = [];

  for (const tire of tires) {
    const snap = tire.vidaSnapshots[0];
    const snapMarca = snap?.bandaMarca?.trim();
    const newMarca = snapMarca || tire.diseno?.trim();

    if (!newMarca) {
      console.warn(`  skip ${tire.id} (${tire.placa}): no diseno or snapshot bandaMarca`);
      continue;
    }

    if (tire.marca.trim().toLowerCase() === newMarca.toLowerCase()) {
      alreadyCorrect++;
      continue;
    }

    willUpdate++;
    if (snapMarca) snapshotSource++;
    else disenoSource++;

    if (preview.length < 15) {
      preview.push({
        id: tire.id,
        placa: tire.placa,
        before: tire.marca,
        after: newMarca,
        source: snapMarca ? 'snapshot.bandaMarca' : 'tire.diseno',
      });
    }

    if (APPLY) {
      await prisma.tire.update({
        where: { id: tire.id },
        data: { marca: newMarca },
      });
    }
  }

  console.log('─'.repeat(80));
  console.log(`Plan: update ${willUpdate} tires, leave ${alreadyCorrect} unchanged.`);
  console.log(`  source=snapshot.bandaMarca : ${snapshotSource}`);
  console.log(`  source=tire.diseno         : ${disenoSource}`);
  console.log('─'.repeat(80));
  console.log('Sample (up to 15 rows):');
  for (const p of preview) {
    console.log(`  ${p.placa.padEnd(12)} ${p.before.padEnd(22)} → ${p.after.padEnd(22)}  (${p.source})`);
  }
  console.log('─'.repeat(80));
  console.log(APPLY ? `✅ Applied ${willUpdate} updates.` : `Dry-run only. Re-run with --apply to write changes.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
