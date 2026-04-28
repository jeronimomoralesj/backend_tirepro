/**
 * For MERQUEPRO tires that have current-depth data but no Inspeccion row,
 * synthesize ONE inspection from the tire's own fields so the UI (which
 * reads per-column values from the latest inspection) has something to show.
 *
 * Also estimate km for tires with consumedDepth > 0 but km=0 using peer
 * mileageByMillimeter means.
 */
import { PrismaClient } from '@prisma/client';
import * as fs from 'node:fs';
import * as path from 'node:path';
const prisma = new PrismaClient();

function num(v: any): number {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

(async () => {
  // Load MERQUEPRO tire rows, keyed by externalSourceId
  const all: any[] = [];
  for (const f of fs.readdirSync('/tmp/merquepro').filter(x => x.startsWith('tires_p'))) {
    all.push(...JSON.parse(fs.readFileSync(path.join('/tmp/merquepro', f), 'utf-8')));
  }
  const byExt = new Map<string, any>();
  // keep latest row per (client, dial)
  for (const r of all) {
    const client = (r.client ?? '').trim();
    if (!client || r.dialNumber == null) continue;
    byExt.set(`merquepro:tire:${r.id}`, r);
  }

  // Build peer mean of mileageByMillimeter per (dimension, vida)
  // (plus a single global fallback) so we can compute km = rate × consumed.
  const rateByDimVida = new Map<string, { sum: number; n: number }>();
  const rateByVida = new Map<string, { sum: number; n: number }>();
  let globalSum = 0, globalN = 0;
  for (const r of all) {
    const mm = num(r.mileageByMillimeter);
    if (mm <= 0) continue;
    const dim = (r.dimension ?? '').toLowerCase();
    const vida = (r.state ?? '').toLowerCase().startsWith('desecho') ? 'fin'
               : (r.state ?? '').toLowerCase().startsWith('reencauche') ? 'reencauche1'
               : 'nueva';
    const k = `${dim}|${vida}`;
    const a = rateByDimVida.get(k); if (a) { a.sum += mm; a.n++; } else rateByDimVida.set(k, { sum: mm, n: 1 });
    const b = rateByVida.get(vida); if (b) { b.sum += mm; b.n++; } else rateByVida.set(vida, { sum: mm, n: 1 });
    globalSum += mm; globalN++;
  }
  const rateAvg = (dim: string, vida: string) => {
    const a = rateByDimVida.get(`${dim.toLowerCase()}|${vida}`);
    if (a && a.n > 0) return a.sum / a.n;
    const b = rateByVida.get(vida);
    if (b && b.n > 0) return b.sum / b.n;
    return globalN > 0 ? globalSum / globalN : 10000;
  };
  console.log(`mileageByMm estimators: ${rateByDimVida.size} dim+vida, ${rateByVida.size} vida, global=${Math.round(globalSum/Math.max(globalN,1))}`);

  // All merquepro tires with NO inspections
  const tires = await prisma.$queryRawUnsafe<any[]>(`
    SELECT t.id, t."externalSourceId", t."fechaInstalacion",
           t."profundidadInicial", t."currentProfundidad", t."vidaActual",
           t.dimension, t."kilometrosRecorridos",
           v.placa AS veh_placa, v."kilometrajeActual" AS veh_km
      FROM "Tire" t
 LEFT JOIN "Vehicle" v ON v.id = t."vehicleId"
     WHERE t."externalSourceId" LIKE 'merquepro:%'
       AND NOT EXISTS (SELECT 1 FROM inspecciones i WHERE i."tireId" = t.id)
  `);
  console.log(`merquepro tires with no inspection: ${tires.length}`);

  let inspCreated = 0, kmFilled = 0, skipped = 0;
  const BATCH = 50;
  const started = Date.now();

  for (let i = 0; i < tires.length; i += BATCH) {
    const slice = tires.slice(i, i + BATCH);
    await Promise.all(slice.map(async (t) => {
      const mp = byExt.get(t.externalSourceId);
      if (!mp) { skipped++; return; }

      // Derive km if missing using consumed × rate
      let newKm = t.kilometrosRecorridos ?? 0;
      const consumed = num(mp.consumedDepth);
      if (newKm === 0 && consumed > 0) {
        const rate = rateAvg(mp.dimension ?? '', t.vidaActual);
        const est = Math.round(rate * consumed);
        if (est > 0) newKm = Math.min(est, 250000);
      }

      // Depth: prefer per-position currents, else scalar, else initial
      const curInt = num(mp.currentInternalDepth);
      const curCen = num(mp.currentCentralDepth);
      const curExt = num(mp.currentExternalDepth);
      const scalar = num(mp.depth);
      const initial = num(mp.originalDepth) || t.profundidadInicial || 0;
      const pInt = curInt > 0 ? curInt : scalar > 0 ? scalar : initial;
      const pCen = curCen > 0 ? curCen : scalar > 0 ? scalar : initial;
      const pExt = curExt > 0 ? curExt : scalar > 0 ? scalar : initial;
      if (pInt === 0 && pCen === 0 && pExt === 0) { skipped++; return; }

      const fecha = mp.createdDate ? new Date(mp.createdDate) : (t.fechaInstalacion ?? new Date());

      // Synthesize one Inspeccion using the tire's MERQUEPRO row as the
      // single data point. externalSourceId tagged as synth: so a future
      // real inspection import won't collide.
      const extInsp = `merquepro:synth:${mp.id}`;
      const existing = await prisma.inspeccion.findUnique({ where: { externalSourceId: extInsp } }).catch(() => null);
      if (existing) { skipped++; return; }

      await prisma.inspeccion.create({
        data: {
          tireId: t.id,
          fecha,
          profundidadInt: pInt,
          profundidadCen: pCen,
          profundidadExt: pExt,
          presionPsi: null,
          kmActualVehiculo: t.veh_km ?? null,
          kmEfectivos: newKm > 0 ? newKm : null,
          kilometrosEstimados: newKm > 0 ? newKm : null,
          vidaAlMomento: t.vidaActual,
          inspeccionadoPorNombre: 'MERQUEPRO (histórico)',
          externalSourceId: extInsp,
        },
      });
      inspCreated++;

      // Update tire's km + currentProfundidad if we improved them
      const avgDepth = Math.round(((pInt + pCen + pExt) / 3) * 100) / 100;
      const update: any = {};
      if (newKm > (t.kilometrosRecorridos ?? 0)) { update.kilometrosRecorridos = newKm; kmFilled++; }
      if (!t.currentProfundidad || Math.abs(avgDepth - t.currentProfundidad) > 0.1) {
        update.currentProfundidad = avgDepth;
      }
      update.lastInspeccionDate = fecha;
      if (Object.keys(update).length > 0) {
        await prisma.tire.update({ where: { id: t.id }, data: update });
      }
    }));
    if ((i + BATCH) % 2500 === 0 || (i + BATCH) >= tires.length) {
      const s = Math.round((Date.now() - started) / 1000);
      console.log(`  ${Math.min(i + BATCH, tires.length)}/${tires.length}  insp+${inspCreated}  km+${kmFilled}  skip=${skipped}  (${s}s)`);
    }
  }

  console.log(`\ndone. synthesized ${inspCreated} inspections, filled km on ${kmFilled} tires, skipped ${skipped}`);

  // Recompute CPK for tires where we just filled km
  await prisma.$executeRawUnsafe(`
    UPDATE "Tire" t
       SET "currentCpk" = CASE
         WHEN (cs.total / t."kilometrosRecorridos") > 500 THEN t."currentCpk"
         ELSE ROUND((cs.total / t."kilometrosRecorridos")::numeric, 2)
       END
      FROM (SELECT "tireId", SUM(valor)::numeric AS total FROM tire_costos GROUP BY "tireId") cs
     WHERE t.id = cs."tireId"
       AND t."externalSourceId" LIKE 'merquepro:%'
       AND t."kilometrosRecorridos" > 0
       AND cs.total > 0
  `);

  const final = await prisma.$queryRawUnsafe<any[]>(`
    SELECT 
      COUNT(*) FILTER (WHERE "currentCpk" IS NOT NULL)::int AS has_cpk,
      COUNT(*) FILTER (WHERE "kilometrosRecorridos" > 0)::int AS has_km,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM inspecciones i WHERE i."tireId" = t.id))::int AS has_insp,
      COUNT(*)::int AS total
    FROM "Tire" t WHERE t."externalSourceId" LIKE 'merquepro:%'
  `);
  console.log('final:', final);
})().finally(() => prisma.$disconnect());
