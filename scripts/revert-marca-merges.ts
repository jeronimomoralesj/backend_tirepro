/**
 * Targeted revert: undo the two bad marca merges.
 *   GREMAX (82 tires) was incorrectly renamed → REMAX
 *   AFECESS (23 tires) was incorrectly renamed → SAFECESS
 *
 * Strategy: GREMAX and REMAX are different brands with different tread
 * designs. We group current "REMAX" tires by diseno and companyId to
 * identify which ones were originally GREMAX, then revert them.
 *
 * Usage:
 *   npx tsx scripts/revert-marca-merges.ts              # shows plan + applies
 *   npx tsx scripts/revert-marca-merges.ts --dry-run     # shows plan only
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');

async function revertMerge(wrongMarca: string, correctMarca: string, expectedCount: number) {
  console.log(`\n── Reverting: "${correctMarca}" tires that were merged into "${wrongMarca}" ──\n`);

  const tires = await prisma.tire.findMany({
    where: { marca: wrongMarca },
    select: { id: true, placa: true, diseno: true, dimension: true, companyId: true },
    orderBy: { companyId: 'asc' },
  });

  console.log(`  Total "${wrongMarca}" tires in DB: ${tires.length}`);

  // Group by companyId + diseno to find clusters
  const byCompany = new Map<string, typeof tires>();
  for (const t of tires) {
    const key = t.companyId || '(none)';
    if (!byCompany.has(key)) byCompany.set(key, []);
    byCompany.get(key)!.push(t);
  }

  console.log(`  Spread across ${byCompany.size} companies:\n`);
  for (const [cid, group] of byCompany) {
    const disenos = [...new Set(group.map(t => t.diseno))].join(', ');
    console.log(`    Company ${cid.slice(0, 12)}…  ${group.length} tires  disenos: [${disenos}]`);
  }

  // The merge took exactly `expectedCount` tires FROM correctMarca INTO wrongMarca.
  // Before the merge, those tires had marca=correctMarca.
  // After: they have marca=wrongMarca alongside the original wrongMarca tires.
  //
  // If a company ONLY has exactly expectedCount tires with this marca,
  // they are very likely the merged ones.
  //
  // Better heuristic: look for companies that gained tires from the merge.
  // A company that had GREMAX tires wouldn't also have REMAX tires (different brand).
  // So companies where ALL tires of this marca = expectedCount are the merged ones.
  //
  // Safest: if total == expectedCount, ALL of them are the wrong brand
  // (meaning the original wrongMarca brand had 0 tires — unlikely but possible).
  // If total > expectedCount, we need to identify the subset.

  if (tires.length === expectedCount) {
    // Edge case: there were NO original wrongMarca tires — all are correctMarca
    console.log(`\n  ⚡ Total (${tires.length}) matches merge count (${expectedCount}).`);
    console.log(`     This means ALL "${wrongMarca}" tires are actually "${correctMarca}".`);

    if (!DRY_RUN) {
      const result = await prisma.tire.updateMany({
        where: { marca: wrongMarca },
        data: { marca: correctMarca },
      });
      console.log(`     ✓ Reverted ${result.count} tires: ${wrongMarca} → ${correctMarca}`);
    } else {
      console.log(`     [DRY RUN] Would revert all ${tires.length} tires.`);
    }
    return;
  }

  if (tires.length < expectedCount) {
    console.log(`\n  ⚠ Total (${tires.length}) is LESS than merge count (${expectedCount}).`);
    console.log(`    Some may have been deleted or changed since the merge. Reverting all.`);

    if (!DRY_RUN) {
      const result = await prisma.tire.updateMany({
        where: { marca: wrongMarca },
        data: { marca: correctMarca },
      });
      console.log(`     ✓ Reverted ${result.count} tires: ${wrongMarca} → ${correctMarca}`);
    } else {
      console.log(`     [DRY RUN] Would revert all ${tires.length} tires.`);
    }
    return;
  }

  // total > expectedCount — there are legitimate wrongMarca tires mixed in.
  // Identify clusters: if a company has tires of BOTH brands, the ones
  // from a company that previously only had correctMarca will cluster.
  // We pick the smallest set of companies whose tire count sums to expectedCount.

  console.log(`\n  Total (${tires.length}) > merge count (${expectedCount}).`);
  console.log(`  Need to identify which ${expectedCount} were originally "${correctMarca}".\n`);

  // Sort companies by size ascending — smaller groups are more likely to be
  // the merged-in brand (the minority).
  const sorted = [...byCompany.entries()].sort((a, b) => a[1].length - b[1].length);

  // Greedy: pick companies starting from smallest until we reach expectedCount
  let remaining = expectedCount;
  const revertCompanies: string[] = [];
  const revertIds: string[] = [];

  for (const [cid, group] of sorted) {
    if (remaining <= 0) break;
    if (group.length <= remaining) {
      revertCompanies.push(cid);
      revertIds.push(...group.map(t => t.id));
      remaining -= group.length;
    }
  }

  if (remaining > 0) {
    // Couldn't cleanly partition — print everything for manual review
    console.log(`  ⚠ Could not cleanly identify ${expectedCount} tires by company grouping.`);
    console.log(`    ${remaining} tires unaccounted for. Manual review needed.`);
    console.log(`\n  All "${wrongMarca}" tires:`);
    for (const t of tires) {
      console.log(`    ${t.id}  placa=${t.placa}  diseno=${t.diseno}  company=${(t.companyId || '').slice(0, 12)}`);
    }
    return;
  }

  console.log(`  Plan: revert ${revertIds.length} tires from ${revertCompanies.length} companies:`);
  for (const cid of revertCompanies) {
    const group = byCompany.get(cid)!;
    console.log(`    Company ${cid.slice(0, 12)}…  ${group.length} tires`);
  }

  if (!DRY_RUN) {
    const result = await prisma.tire.updateMany({
      where: { id: { in: revertIds } },
      data: { marca: correctMarca },
    });
    console.log(`\n  ✓ Reverted ${result.count} tires: ${wrongMarca} → ${correctMarca}`);
  } else {
    console.log(`\n  [DRY RUN] Would revert ${revertIds.length} tires.`);
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Revert Bad Marca Merges');
  console.log(`  Mode: ${DRY_RUN ? '*** DRY RUN ***' : 'LIVE'}`);
  console.log('═══════════════════════════════════════════════════════════');

  await revertMerge('REMAX',    'GREMAX',  82);
  await revertMerge('SAFECESS', 'AFECESS', 23);

  console.log('\n  Done.\n');
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  prisma.$disconnect();
  process.exit(1);
});
