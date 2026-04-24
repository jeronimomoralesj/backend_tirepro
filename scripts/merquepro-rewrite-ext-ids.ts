/**
 * One-time migration: rewrite merquepro externalSourceIds from the unstable
 * UUID form ("merquepro:tire:<uuid>") to the stable numeric form
 * ("merquepro:tire:<tireId>"). Same for inspections.
 *
 * Why: Merquellantas regenerates the UUID `id` field on every API call, so
 * using it as an external-source key makes subsequent imports create
 * duplicate rows instead of updating existing ones. The numeric `tireId`
 * field is stable across calls.
 *
 *   npx ts-node scripts/merquepro-rewrite-ext-ids.ts --apply
 */
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

async function main() {
  console.log(APPLY ? '▶ APPLY' : '◇ DRY-RUN');

  // Tires — rewrite merquepro:tire:<uuid> → merquepro:tire:<sourceMetadata.tireId>
  // For rows where sourceMetadata already has _currentState.tireId, prefer
  // that (most recent). Fall back to sourceMetadata.tireId.
  const tiresToFix: any[] = await prisma.$queryRaw`
    SELECT id, "externalSourceId",
           COALESCE(
             ("sourceMetadata"->'_currentState'->>'tireId')::int,
             ("sourceMetadata"->>'tireId')::int
           ) AS tire_id
      FROM "Tire"
     WHERE "externalSourceId" LIKE 'merquepro:tire:%'
       AND "externalSourceId" NOT SIMILAR TO 'merquepro:tire:[0-9]+'
  `;
  console.log(`Tires needing rewrite: ${tiresToFix.length}`);
  let tireRewritten = 0, tireMergedAndDeleted = 0, tireSkipped = 0;
  for (const row of tiresToFix) {
    if (row.tire_id == null) { tireSkipped++; continue; }
    const newExt = `merquepro:tire:${row.tire_id}`;
    if (!APPLY) { tireRewritten++; continue; }
    try {
      await prisma.tire.update({ where: { id: row.id }, data: { externalSourceId: newExt } });
      tireRewritten++;
    } catch (err: any) {
      if (err?.code !== 'P2002') throw err;
      // Another row already holds the new extId. That row is the same
      // physical tire (same numeric tireId). Merge: migrate costos, eventos,
      // inspecciones to the keeper, then delete this duplicate.
      const keeper = await prisma.tire.findUnique({ where: { externalSourceId: newExt }, select: { id: true } });
      if (!keeper) { tireSkipped++; continue; }
      await prisma.$executeRawUnsafe(`UPDATE tire_costos SET "tireId" = $1 WHERE "tireId" = $2`, keeper.id, row.id);
      await prisma.$executeRawUnsafe(`UPDATE tire_eventos SET "tireId" = $1 WHERE "tireId" = $2`, keeper.id, row.id);
      await prisma.$executeRawUnsafe(`UPDATE inspecciones SET "tireId" = $1 WHERE "tireId" = $2`, keeper.id, row.id);
      try { await prisma.tire.delete({ where: { id: row.id } }); tireMergedAndDeleted++; }
      catch { tireSkipped++; }
    }
  }
  console.log(`Tires rewritten: ${tireRewritten}  merged+deleted: ${tireMergedAndDeleted}  skipped: ${tireSkipped}`);

  // Inspections — rewrite merquepro:insp:<uuid> → merquepro:insp:<tireId>:<consecutive>
  const inspsToFix: any[] = await prisma.$queryRaw`
    SELECT id, "externalSourceId",
           ("sourceMetadata"->>'tireId')::int AS tire_id,
           COALESCE(
             ("sourceMetadata"->>'consecutiveInspection')::int,
             ("sourceMetadata"->>'consecutive')::int
           ) AS consec
      FROM inspecciones
     WHERE "externalSourceId" LIKE 'merquepro:insp:%'
       AND "externalSourceId" NOT LIKE 'merquepro:insp:synthetic:%'
       AND "externalSourceId" NOT SIMILAR TO 'merquepro:insp:[0-9]+:[0-9]+'
  `;
  console.log(`Inspections needing rewrite: ${inspsToFix.length}`);
  let inspRewritten = 0, inspDeleted = 0, inspSkipped = 0;
  for (const row of inspsToFix) {
    if (row.tire_id == null || row.consec == null) { inspSkipped++; continue; }
    const newExt = `merquepro:insp:${row.tire_id}:${row.consec}`;
    if (!APPLY) { inspRewritten++; continue; }
    try {
      await prisma.inspeccion.update({ where: { id: row.id }, data: { externalSourceId: newExt } });
      inspRewritten++;
    } catch (err: any) {
      if (err?.code !== 'P2002') throw err;
      // Keep whichever one already holds the new ext; drop this.
      try { await prisma.inspeccion.delete({ where: { id: row.id } }); inspDeleted++; }
      catch { inspSkipped++; }
    }
  }
  console.log(`Inspections rewritten: ${inspRewritten}  dropped-as-dup: ${inspDeleted}  skipped: ${inspSkipped}`);

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
