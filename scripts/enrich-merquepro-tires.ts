/**
 * Post-import enrichment: reads the MERQUEPRO JSON dumps and upgrades
 * kilometrosRecorridos + currentProfundidad + currentCpk for tires whose
 * first-pass values were weak.
 *
 * Priority for kilometrosRecorridos (this life's km):
 *   1. mileageTraveled            — when > 0
 *   2. mileageByMillimeter × consumedDepth
 *   3. inspection-diff (already done in fix-cpk refresh)
 *
 * Priority for currentProfundidad (mm remaining):
 *   1. depth                       — scalar current depth
 *   2. avg(currentInternalDepth, currentCentralDepth, currentExternalDepth)
 *   3. originalDepth − consumedDepth
 *
 * Priority for currentCpk:
 *   1. cpkStad                     — MERQUEPRO's standardized CPK
 *   2. cpk                         — raw MERQUEPRO
 *   3. SUM(tire_costos) / kilometrosRecorridos — computed
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
  // Load all MERQUEPRO tire rows into map keyed by id
  const all: any[] = [];
  for (const f of fs.readdirSync('/tmp/merquepro').filter(x => x.startsWith('tires_p'))) {
    all.push(...JSON.parse(fs.readFileSync(path.join('/tmp/merquepro', f), 'utf-8')));
  }
  // MERQUEPRO has multiple rows per tire. Collapse by (client|dialNumber)
  // keeping the LATEST row by createdDate — matches the importer's rule.
  const latest = new Map<string, any>();
  for (const r of all) {
    const client = (r.client ?? '').trim();
    if (!client || r.dialNumber == null) continue;
    const key = `${client.toLowerCase()}__${r.dialNumber}`;
    const prev = latest.get(key);
    const prevD = prev ? new Date(prev.createdDate ?? 0).getTime() : 0;
    const thisD = new Date(r.createdDate ?? 0).getTime();
    if (!prev || thisD > prevD) latest.set(key, r);
  }

  // Map by externalSourceId (merquepro:tire:<id>)
  const byExt = new Map<string, any>();
  for (const r of latest.values()) {
    byExt.set(`merquepro:tire:${r.id}`, r);
  }
  console.log(`loaded ${byExt.size} canonical MERQUEPRO tire rows`);

  // Fetch all imported tires in one shot
  const tires = await prisma.tire.findMany({
    where: { externalSourceId: { startsWith: 'merquepro:tire:' } },
    select: {
      id: true, externalSourceId: true,
      kilometrosRecorridos: true, currentCpk: true,
      currentProfundidad: true, profundidadInicial: true,
    },
  });
  console.log(`loaded ${tires.length} imported tires`);

  // Build cost sums map for the last-ditch CPK computation
  const costSums = new Map<string, number>();
  const costRows = await prisma.$queryRawUnsafe<any[]>(`
    SELECT "tireId", SUM(valor)::numeric AS total
      FROM tire_costos
     WHERE "tireId" IN (SELECT id FROM "Tire" WHERE "externalSourceId" LIKE 'merquepro:tire:%')
     GROUP BY "tireId"
  `);
  for (const r of costRows) costSums.set(r.tireId, Number(r.total));

  const CAP = { nueva: 250_000, reencauche1: 200_000, reencauche2: 180_000, reencauche3: 160_000, fin: 250_000 };
  const capKm = (km: number, vida: string) => Math.min(Math.max(0, Math.round(km)), (CAP as any)[vida] ?? 250_000);

  let updated = 0, kmImproved = 0, cpkImproved = 0, depthImproved = 0;
  const BATCH = 50;
  const started = Date.now();

  for (let i = 0; i < tires.length; i += BATCH) {
    const slice = tires.slice(i, i + BATCH);
    await Promise.all(slice.map(async (t) => {
      const ext = t.externalSourceId!;
      const mp = byExt.get(ext);
      if (!mp) return;

      const vida = (mp.state ?? '').toLowerCase().startsWith('desecho') ? 'fin'
                 : (mp.state ?? '').toLowerCase().startsWith('reencauche') ? 'reencauche1'
                 : 'nueva';

      // km
      let newKm = t.kilometrosRecorridos;
      const direct = num(mp.mileageTraveled);
      const fromRate = num(mp.mileageByMillimeter) * num(mp.consumedDepth);
      const bestRawKm = Math.max(direct, fromRate);
      if (bestRawKm > 0) {
        const capped = capKm(bestRawKm, vida);
        if (capped > newKm) { newKm = capped; kmImproved++; }
      }

      // profundidad (mm remaining)
      let newDepth = t.currentProfundidad;
      const scalar = num(mp.depth);
      const avgCur = (num(mp.currentInternalDepth) + num(mp.currentCentralDepth) + num(mp.currentExternalDepth)) / 3;
      const fromConsumed = num(mp.originalDepth) - num(mp.consumedDepth);
      const candidate = scalar > 0 ? scalar
                      : avgCur > 0 ? avgCur
                      : fromConsumed > 0 ? fromConsumed
                      : 0;
      if (candidate > 0 && (!newDepth || Math.abs(candidate - newDepth) > 0.1)) {
        newDepth = Math.round(candidate * 100) / 100;
        depthImproved++;
      }

      // cpk
      let newCpk = t.currentCpk;
      const cpkStad = num(mp.cpkStad);
      const cpkRaw = num(mp.cpk);
      const costSum = costSums.get(t.id) ?? 0;
      const bestMerquepro = cpkStad > 0 ? cpkStad : cpkRaw;
      if (bestMerquepro > 0) {
        if (!newCpk || Math.abs(bestMerquepro - newCpk) / Math.max(newCpk, 1) > 0.1) {
          newCpk = Math.round(bestMerquepro * 100) / 100;
          cpkImproved++;
        }
      } else if (newKm > 0 && costSum > 0) {
        const computed = Math.round((costSum / newKm) * 100) / 100;
        if (!newCpk || Math.abs(computed - newCpk) > 0.5) {
          newCpk = computed;
          cpkImproved++;
        }
      }

      const changed = newKm !== t.kilometrosRecorridos ||
                      newDepth !== t.currentProfundidad ||
                      newCpk !== t.currentCpk;
      if (!changed) return;
      await prisma.tire.update({
        where: { id: t.id },
        data: {
          kilometrosRecorridos: newKm,
          currentProfundidad: newDepth,
          currentCpk: newCpk,
        },
      });
      updated++;
    }));
    if ((i + BATCH) % 2500 === 0 || (i + BATCH) >= tires.length) {
      const s = Math.round((Date.now() - started) / 1000);
      console.log(`  ${Math.min(i + BATCH, tires.length)}/${tires.length}  updated=${updated}  kmImp=${kmImproved}  cpkImp=${cpkImproved}  depthImp=${depthImproved}  (${s}s)`);
    }
  }
  console.log(`\ndone. updated=${updated}  kmImproved=${kmImproved}  cpkImproved=${cpkImproved}  depthImproved=${depthImproved}`);

  // Stats
  const stats = await prisma.$queryRawUnsafe<any[]>(`
    SELECT 
      COUNT(*) FILTER (WHERE "currentCpk" IS NOT NULL)::int AS has_cpk,
      COUNT(*) FILTER (WHERE "kilometrosRecorridos" > 0)::int AS has_km,
      COUNT(*)::int AS total,
      ROUND(AVG("currentCpk")::numeric, 2) AS avg_cpk
    FROM "Tire" WHERE "externalSourceId" LIKE 'merquepro:%'
  `);
  console.log('merquepro stats:', stats);
})().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
