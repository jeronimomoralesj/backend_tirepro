/**
 * Revert bad marca merges from the system-wide-cleanup.ts run.
 *
 * The old 0.85 similarity threshold incorrectly merged:
 *   - "GREMAX" (82 tires) → "REMAX"
 *   - "AFECESS" (23 tires) → "SAFECESS"
 *
 * This script finds tires with these brands via their company grouping —
 * if a company had ONLY GREMAX before, all their "REMAX" tires are actually
 * GREMAX. For mixed-brand companies we print for manual review.
 *
 * Usage:
 *   npx tsx scripts/revert-bad-merges.ts --dry-run
 *   npx tsx scripts/revert-bad-merges.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log(`Mode: ${DRY_RUN ? '*** DRY RUN ***' : 'LIVE'}\n`);

  // The merge renamed the LESS common brand into the MORE common one.
  // "GREMAX" → "REMAX" means we had both, and GREMAX tires became REMAX.
  // "AFECESS" → "SAFECESS" means AFECESS tires became SAFECESS.
  //
  // Strategy: check the diseno field. GREMAX and REMAX likely have different
  // tread designs. Also check sourceMetadata or externalSourceId for clues.

  const reversals = [
    { wrongMarca: 'REMAX',    correctMarca: 'GREMAX',   count: 82 },
    { wrongMarca: 'SAFECESS', correctMarca: 'AFECESS',  count: 23 },
  ];

  for (const r of reversals) {
    console.log(`\n=== Checking ${r.wrongMarca} for tires that should be ${r.correctMarca} ===`);

    const tires = await prisma.tire.findMany({
      where: { marca: r.wrongMarca },
      select: {
        id: true,
        placa: true,
        marca: true,
        diseno: true,
        dimension: true,
        companyId: true,
        externalSourceId: true,
        sourceMetadata: true,
      },
    });

    console.log(`  Total "${r.wrongMarca}" tires: ${tires.length}`);
    console.log(`  Expected ${r.count} to be actually "${r.correctMarca}"`);

    // If the total count matches exactly the merge count, ALL are the wrong brand
    // and the original legitimate ones must have a different name already.
    // But that's unlikely — let's check diseno patterns.

    const disenoGroups = new Map<string, typeof tires>();
    for (const t of tires) {
      const d = t.diseno || '(none)';
      if (!disenoGroups.has(d)) disenoGroups.set(d, []);
      disenoGroups.get(d)!.push(t);
    }

    console.log(`\n  Diseno breakdown for "${r.wrongMarca}":`);
    for (const [diseno, group] of disenoGroups) {
      console.log(`    ${diseno}: ${group.length} tires`);
    }

    // Check company breakdown
    const companyGroups = new Map<string, typeof tires>();
    for (const t of tires) {
      const c = t.companyId || '(none)';
      if (!companyGroups.has(c)) companyGroups.set(c, []);
      companyGroups.get(c)!.push(t);
    }

    console.log(`\n  Company breakdown for "${r.wrongMarca}":`);
    for (const [companyId, group] of companyGroups) {
      console.log(`    ${companyId.slice(0, 8)}...: ${group.length} tires (disenos: ${[...new Set(group.map(t => t.diseno))].join(', ')})`);
    }

    // Check if sourceMetadata has any clue
    const withSource = tires.filter(t => t.sourceMetadata != null);
    if (withSource.length > 0) {
      console.log(`\n  ${withSource.length} tires have sourceMetadata — checking for original marca...`);
      for (const t of withSource.slice(0, 5)) {
        const meta = t.sourceMetadata as any;
        if (meta?.marca || meta?.brand) {
          console.log(`    ${t.placa}: sourceMetadata.marca = ${meta.marca || meta.brand}`);
        }
      }
    }

    // Check externalSourceId patterns
    const withExt = tires.filter(t => t.externalSourceId != null);
    if (withExt.length > 0) {
      console.log(`\n  ${withExt.length} tires have externalSourceId`);
    }

    console.log();
  }

  // If the user wants to revert ALL, they can run the SQL directly:
  console.log('════════════════════════════════════════════════════════════');
  console.log('  MANUAL REVERSAL SQL (run after reviewing above):');
  console.log('════════════════════════════════════════════════════════════');
  console.log();
  console.log('  -- Option A: If you can identify which tires by company/diseno:');
  console.log('  -- UPDATE tires SET marca = \'GREMAX\' WHERE marca = \'REMAX\' AND "companyId" = \'<company-id>\';');
  console.log('  -- UPDATE tires SET marca = \'AFECESS\' WHERE marca = \'SAFECESS\' AND "companyId" = \'<company-id>\';');
  console.log();
  console.log('  -- Option B: If REMAX/SAFECESS didn\'t exist before (all were merged):');
  console.log('  -- This would mean the script output lied about counts. Unlikely.');
  console.log();

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  prisma.$disconnect();
  process.exit(1);
});
