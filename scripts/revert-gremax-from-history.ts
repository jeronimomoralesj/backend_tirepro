/**
 * Revert GREMAX→REMAX merge using vehicle_tire_history as source of truth.
 * Each tire's sourceMetadata.historyId points to the VehicleTireHistory row
 * that has the original marca before the cleanup script changed it.
 *
 * Also handles AFECESS→SAFECESS the same way.
 *
 * Usage:
 *   npx tsx scripts/revert-gremax-from-history.ts --dry-run
 *   npx tsx scripts/revert-gremax-from-history.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');

async function revertFromHistory(currentMarca: string) {
  console.log(`\n── Checking "${currentMarca}" tires against vehicle_tire_history ──\n`);

  const tires = await prisma.tire.findMany({
    where: { marca: currentMarca },
    select: { id: true, placa: true, marca: true, sourceMetadata: true },
  });

  console.log(`  Total "${currentMarca}" tires: ${tires.length}`);

  const reverts: { id: string; placa: string; originalMarca: string }[] = [];
  let noHistory = 0;

  for (const t of tires) {
    const meta = t.sourceMetadata as any;
    const historyId = meta?.historyId;

    if (!historyId) {
      noHistory++;
      continue;
    }

    const history = await prisma.vehicleTireHistory.findUnique({
      where: { id: historyId },
      select: { marca: true },
    });

    if (!history) {
      noHistory++;
      continue;
    }

    const originalMarca = history.marca.trim().toUpperCase();
    if (originalMarca !== currentMarca) {
      reverts.push({ id: t.id, placa: t.placa, originalMarca });
    }
  }

  // Group by original marca
  const byMarca = new Map<string, typeof reverts>();
  for (const r of reverts) {
    if (!byMarca.has(r.originalMarca)) byMarca.set(r.originalMarca, []);
    byMarca.get(r.originalMarca)!.push(r);
  }

  console.log(`  Tires without history link: ${noHistory}`);
  console.log(`  Tires needing revert: ${reverts.length}`);

  for (const [marca, group] of byMarca) {
    console.log(`\n    "${currentMarca}" → "${marca}": ${group.length} tires`);
    for (const r of group.slice(0, 5)) {
      console.log(`      ${r.placa}`);
    }
    if (group.length > 5) console.log(`      ... and ${group.length - 5} more`);

    if (!DRY_RUN) {
      const ids = group.map(r => r.id);
      const result = await prisma.tire.updateMany({
        where: { id: { in: ids } },
        data: { marca },
      });
      console.log(`    ✓ Reverted ${result.count} tires to "${marca}"`);
    }
  }

  if (reverts.length === 0) {
    console.log('  Nothing to revert — all tires match their history.');
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Revert Bad Merges via vehicle_tire_history');
  console.log(`  Mode: ${DRY_RUN ? '*** DRY RUN ***' : 'LIVE'}`);
  console.log('═══════════════════════════════════════════════════════════');

  await revertFromHistory('REMAX');
  await revertFromHistory('SAFECESS');

  console.log('\n  Done.\n');
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  prisma.$disconnect();
  process.exit(1);
});
