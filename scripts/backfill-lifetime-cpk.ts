/**
 * Backfills Tire.lifetimeCpk and inspeccion.lifetimeCpk for the whole
 * fleet so company-wide dashboards have data on first deploy.
 *
 *   lifetimeCpk = sumAllCosts / totalKm
 *
 * totalKm is the tire's kilometrosRecorridos (the odometer accumulates
 * across vidas in TirePro). Costs include nueva purchase + every retread.
 *
 * Usage:
 *   npx ts-node scripts/backfill-lifetime-cpk.ts [--apply]
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

function cpk(totalCost: number, totalKm: number): number | null {
  if (!totalCost || totalCost <= 0) return null;
  if (!totalKm   || totalKm   <= 0) return null;
  return parseFloat((totalCost / totalKm).toFixed(2));
}

async function main() {
  const tires = await prisma.tire.findMany({
    select: {
      id: true,
      placa: true,
      kilometrosRecorridos: true,
      lifetimeCpk: true,
      costos: { select: { valor: true, fecha: true }, orderBy: { fecha: 'asc' } },
      inspecciones: { select: { id: true, fecha: true, lifetimeCpk: true, kilometrosEstimados: true }, orderBy: { fecha: 'asc' } },
    },
  });

  let tireUpdated   = 0;
  let tireUnchanged = 0;
  let tireSkipped   = 0;
  let inspUpdated   = 0;

  const preview: Array<{ placa: string; before: number | null; after: number | null; costs: number; km: number }> = [];

  for (const t of tires) {
    const totalCost = t.costos.reduce((s, c) => s + (c.valor ?? 0), 0);
    const totalKm   = t.kilometrosRecorridos || 0;
    const nextCpk   = cpk(totalCost, totalKm);

    // Per-inspection lifetimeCpk: accumulate cost up to each inspection's
    // date and divide by that inspection's odometer reading.
    const inspUpdates: { id: string; lifetimeCpk: number | null }[] = [];
    for (const i of t.inspecciones) {
      const costToDate = t.costos
        .filter((c) => new Date(c.fecha) <= new Date(i.fecha))
        .reduce((s, c) => s + (c.valor ?? 0), 0);
      const km = i.kilometrosEstimados ?? 0;
      const inspCpk = cpk(costToDate, km);
      const currentRounded = i.lifetimeCpk != null ? Math.round(i.lifetimeCpk * 100) / 100 : null;
      if (currentRounded !== inspCpk) {
        inspUpdates.push({ id: i.id, lifetimeCpk: inspCpk });
      }
    }

    if (nextCpk == null) {
      tireSkipped++;
    } else if (t.lifetimeCpk != null && Math.round(t.lifetimeCpk * 100) / 100 === nextCpk) {
      tireUnchanged++;
    } else {
      tireUpdated++;
      if (preview.length < 10) {
        preview.push({ placa: t.placa, before: t.lifetimeCpk, after: nextCpk, costs: totalCost, km: totalKm });
      }
    }

    if (APPLY) {
      await prisma.tire.update({ where: { id: t.id }, data: { lifetimeCpk: nextCpk } });
      for (const u of inspUpdates) {
        await prisma.inspeccion.update({ where: { id: u.id }, data: { lifetimeCpk: u.lifetimeCpk } });
        inspUpdated++;
      }
    } else {
      inspUpdated += inspUpdates.length;
    }
  }

  const bar = '─'.repeat(80);
  console.log(bar);
  console.log(`Tires scanned:     ${tires.length}`);
  console.log(`  lifetimeCpk updated:   ${tireUpdated}`);
  console.log(`  lifetimeCpk unchanged: ${tireUnchanged}`);
  console.log(`  skipped (no cost/km):  ${tireSkipped}`);
  console.log(`Inspection rows ${APPLY ? 'updated' : 'would be updated'}: ${inspUpdated}`);
  console.log(bar);
  console.log('Sample tire updates (up to 10):');
  for (const p of preview) {
    console.log(`  ${p.placa.padEnd(14)} $${String(p.before ?? '—').padEnd(10)} → $${p.after}   (costs=$${p.costs.toLocaleString('es-CO')}, km=${p.km.toLocaleString('es-CO')})`);
  }
  console.log(bar);
  console.log(APPLY ? `✅ Applied.` : `Dry-run. Re-run with --apply to write.`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
