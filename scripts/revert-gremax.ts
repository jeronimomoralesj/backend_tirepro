/**
 * Identify and revert the 82 GREMAX tires that were merged into REMAX.
 *
 * All 142 "REMAX" tires are in the same company + same diseno (RDE2),
 * so we check sourceMetadata and externalSourceId for the original marca.
 * If that doesn't work, we check the original Excel import timestamps
 * or fall back to the oldest 82 tires (since the merge script processed
 * them in DB order).
 *
 * Usage:
 *   npx tsx scripts/revert-gremax.ts --dry-run
 *   npx tsx scripts/revert-gremax.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log(`Mode: ${DRY_RUN ? '*** DRY RUN ***' : 'LIVE'}\n`);

  const tires = await prisma.tire.findMany({
    where: { marca: 'REMAX' },
    select: {
      id: true,
      placa: true,
      diseno: true,
      companyId: true,
      externalSourceId: true,
      sourceMetadata: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`Total REMAX tires: ${tires.length}\n`);

  // ── Strategy 1: Check sourceMetadata for original marca ────────────────
  const fromMeta: string[] = [];
  const noMeta: string[] = [];
  let metaHits = 0;

  for (const t of tires) {
    const meta = t.sourceMetadata as any;
    if (meta) {
      const origMarca = meta.marca || meta.brand || meta.MARCA || meta.Brand || null;
      if (origMarca) {
        const upper = String(origMarca).trim().toUpperCase();
        if (upper === 'GREMAX' || upper.includes('GREMAX')) {
          fromMeta.push(t.id);
          metaHits++;
        }
      }
    }
  }

  if (fromMeta.length > 0) {
    console.log(`Strategy 1 (sourceMetadata): found ${fromMeta.length} tires with original marca=GREMAX`);

    if (!DRY_RUN) {
      const result = await prisma.tire.updateMany({
        where: { id: { in: fromMeta } },
        data: { marca: 'GREMAX' },
      });
      console.log(`✓ Reverted ${result.count} tires to GREMAX`);
    } else {
      console.log(`[DRY RUN] Would revert ${fromMeta.length} tires.`);
    }
    await prisma.$disconnect();
    return;
  }

  console.log('Strategy 1 (sourceMetadata): no marca field found in metadata.\n');

  // ── Strategy 2: Check externalSourceId patterns ────────────────────────
  const byExtPrefix = new Map<string, string[]>();
  for (const t of tires) {
    if (t.externalSourceId) {
      // External IDs often encode the source: "merquepro-GREMAX-12345"
      const ext = t.externalSourceId.toUpperCase();
      if (ext.includes('GREMAX')) {
        if (!byExtPrefix.has('GREMAX')) byExtPrefix.set('GREMAX', []);
        byExtPrefix.get('GREMAX')!.push(t.id);
      } else if (ext.includes('REMAX')) {
        if (!byExtPrefix.has('REMAX')) byExtPrefix.set('REMAX', []);
        byExtPrefix.get('REMAX')!.push(t.id);
      }
    }
  }

  if (byExtPrefix.has('GREMAX')) {
    const ids = byExtPrefix.get('GREMAX')!;
    console.log(`Strategy 2 (externalSourceId): found ${ids.length} tires with GREMAX in their source ID`);

    if (!DRY_RUN) {
      const result = await prisma.tire.updateMany({
        where: { id: { in: ids } },
        data: { marca: 'GREMAX' },
      });
      console.log(`✓ Reverted ${result.count} tires to GREMAX`);
    } else {
      console.log(`[DRY RUN] Would revert ${ids.length} tires.`);
    }
    await prisma.$disconnect();
    return;
  }

  console.log('Strategy 2 (externalSourceId): no GREMAX pattern in source IDs.\n');

  // ── Strategy 3: Show sample data for manual identification ─────────────
  console.log('Strategy 3: Could not auto-identify. Showing all tires for manual review.\n');

  console.log('  First 20 tires (by createdAt):');
  for (const t of tires.slice(0, 20)) {
    const ext = t.externalSourceId || '(none)';
    const meta = t.sourceMetadata ? JSON.stringify(t.sourceMetadata).slice(0, 80) : '(none)';
    console.log(`    ${t.placa}  created=${t.createdAt.toISOString().split('T')[0]}  ext=${ext}  meta=${meta}`);
  }

  console.log(`\n  Last 20 tires (by createdAt):`);
  for (const t of tires.slice(-20)) {
    const ext = t.externalSourceId || '(none)';
    const meta = t.sourceMetadata ? JSON.stringify(t.sourceMetadata).slice(0, 80) : '(none)';
    console.log(`    ${t.placa}  created=${t.createdAt.toISOString().split('T')[0]}  ext=${ext}  meta=${meta}`);
  }

  // Show distinct creation date batches — imports usually land in batches
  const byDate = new Map<string, number>();
  for (const t of tires) {
    const d = t.createdAt.toISOString().split('T')[0];
    byDate.set(d, (byDate.get(d) || 0) + 1);
  }

  console.log('\n  Creation date distribution:');
  for (const [date, count] of [...byDate.entries()].sort()) {
    console.log(`    ${date}: ${count} tires`);
  }

  console.log('\n  If you can identify the GREMAX tires (e.g. by import batch date),');
  console.log('  run this SQL on the server:');
  console.log('    UPDATE tires SET marca = \'GREMAX\' WHERE marca = \'REMAX\' AND "createdAt"::date = \'YYYY-MM-DD\';');

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  prisma.$disconnect();
  process.exit(1);
});
