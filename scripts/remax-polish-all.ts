/**
 * Non-destructive polish for every Remax-distributor client. Ensures:
 *  - Every tire has a montaje TireEvento (UI shows vida)
 *  - Every tire has at least one tire_costos entry
 *  - Every tire has currentCpk (peer-mean fallback when no real cost)
 *  - Every tire has currentProfundidad (= profundidadInicial if no inspection)
 *  - Every inspection has cpk + cpkProyectado + kmProyectado, capped sanely
 *
 * Reads + writes only — never deletes.
 *
 *   npx ts-node scripts/remax-polish-all.ts --apply
 */
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const REMAX_DISTRIBUTOR_ID = '8be67ba6-2345-428a-846c-1248d6bbc15a';

async function main() {
  console.log(APPLY ? '▶ APPLY' : '◇ DRY-RUN');
  const links = await prisma.distributorAccess.findMany({
    where: { distributorId: REMAX_DISTRIBUTOR_ID },
    select: { companyId: true },
  });
  const companyIds = links.map((l) => l.companyId);
  console.log(`Remax clients: ${companyIds.length}`);

  if (!APPLY) {
    for (const cid of companyIds) {
      const r: any[] = await prisma.$queryRaw`
        SELECT c.name,
          (SELECT COUNT(*)::int FROM "Tire" WHERE "companyId"=${cid}) tires,
          (SELECT COUNT(*)::int FROM "Tire" WHERE "companyId"=${cid} AND "currentCpk" IS NULL) needs_cpk,
          (SELECT COUNT(*)::int FROM "Tire" WHERE "companyId"=${cid} AND "currentProfundidad" IS NULL) needs_depth,
          (SELECT COUNT(DISTINCT "tireId")::int FROM tire_eventos e WHERE e.tipo='montaje' AND e."tireId" IN (SELECT id FROM "Tire" WHERE "companyId"=${cid})) has_vida,
          (SELECT COUNT(*)::int FROM "Tire" WHERE "companyId"=${cid} AND NOT EXISTS (SELECT 1 FROM tire_costos tc WHERE tc."tireId"=id)) needs_cost
          FROM "Company" c WHERE c.id = ${cid}`;
      console.log(JSON.stringify(r[0]));
    }
    await prisma.$disconnect();
    return;
  }

  // Pre-compute peer averages once (used by all companies)
  const peerCpk: any[] = await prisma.$queryRaw`
    SELECT UPPER(TRIM(t.dimension)) dim, ROUND(AVG(t."currentCpk")::numeric,2)::double precision v
      FROM "Tire" t WHERE t."currentCpk" IS NOT NULL AND t."currentCpk" < 500 GROUP BY 1 HAVING COUNT(*) >= 3`;
  const peerCpkMap = new Map<string, number>();
  for (const x of peerCpk) peerCpkMap.set(x.dim, x.v);
  const gCpk: any[] = await prisma.$queryRaw`SELECT ROUND(AVG("currentCpk")::numeric,2)::double precision v FROM "Tire" WHERE "currentCpk" IS NOT NULL AND "currentCpk" < 500`;
  const globalCpk = gCpk[0].v;

  const peerCost: any[] = await prisma.$queryRaw`
    SELECT UPPER(TRIM(t.dimension)) dim, AVG(tc.valor)::int v
      FROM tire_costos tc JOIN "Tire" t ON t.id=tc."tireId"
     WHERE tc.valor > 0 GROUP BY 1`;
  const peerCostMap = new Map<string, number>();
  for (const x of peerCost) peerCostMap.set(x.dim, x.v);
  const gCost: any[] = await prisma.$queryRaw`SELECT AVG(valor)::int v FROM tire_costos WHERE valor > 0`;
  const globalCost = gCost[0].v;

  const peerKmProy: any[] = await prisma.$queryRaw`
    SELECT UPPER(TRIM(t.dimension)) dim, AVG(i."kmProyectado")::double precision v
      FROM "Tire" t JOIN inspecciones i ON i."tireId"=t.id
     WHERE i."kmProyectado" IS NOT NULL AND i."kmProyectado" < 250000 GROUP BY 1 HAVING COUNT(*) >= 3`;
  const peerKmProyMap = new Map<string, number>();
  for (const x of peerKmProy) peerKmProyMap.set(x.dim, x.v);
  const gKmProy: any[] = await prisma.$queryRaw`SELECT AVG("kmProyectado")::int v FROM inspecciones WHERE "kmProyectado" IS NOT NULL AND "kmProyectado" < 250000`;
  const globalKmProy = gKmProy[0].v;

  for (const cid of companyIds) {
    const co = await prisma.company.findUnique({ where: { id: cid }, select: { name: true } });
    console.log('\n● ' + co?.name);

    // 1. Vida events for tires that don't have one
    await prisma.$executeRawUnsafe(`
      INSERT INTO tire_eventos (id, "tireId", tipo, fecha, notas, metadata, "createdAt")
      SELECT gen_random_uuid()::text, t.id, 'montaje'::"TireEventType",
             COALESCE(t."fechaInstalacion", NOW()), t."vidaActual"::text,
             jsonb_build_object('source','remax_polish'), NOW()
        FROM "Tire" t WHERE t."companyId" = $1
         AND NOT EXISTS (SELECT 1 FROM tire_eventos e WHERE e."tireId"=t.id AND e.tipo='montaje'::"TireEventType")`, cid);

    // 2. Costos via peer-mean for tires without one
    const need = await prisma.tire.findMany({ where: { companyId: cid, costos: { none: {} } }, select: { id: true, dimension: true } });
    for (const t of need) {
      const cost = peerCostMap.get(String(t.dimension || '').toUpperCase().trim()) || globalCost;
      if (!cost) continue;
      await prisma.tireCosto.create({ data: { tireId: t.id, valor: cost, fecha: new Date(), concepto: 'peer_mean_cost' } });
    }

    // 3. Sync currentProfundidad from latest inspection, fall back to profundidadInicial
    await prisma.$executeRawUnsafe(`
      UPDATE "Tire" tgt SET "currentProfundidad"=sub.avg_d, "lastInspeccionDate"=sub.fecha
        FROM (SELECT DISTINCT ON ("tireId") "tireId", fecha,
                     ("profundidadInt"+"profundidadCen"+"profundidadExt")/3 avg_d
                FROM inspecciones ORDER BY "tireId", fecha DESC) sub
       WHERE tgt.id=sub."tireId" AND tgt."companyId"=$1`, cid);
    await prisma.$executeRawUnsafe(`UPDATE "Tire" SET "currentProfundidad"="profundidadInicial" WHERE "companyId"=$1 AND "currentProfundidad" IS NULL`, cid);

    // 4. Recompute currentCpk from costos/km, cap at 500, peer-mean fallback
    await prisma.$executeRawUnsafe(`UPDATE "Tire" t SET "currentCpk" = ROUND((cs.total/NULLIF(t."kilometrosRecorridos",0))::numeric,2) FROM (SELECT "tireId", SUM(valor)::numeric total FROM tire_costos GROUP BY "tireId") cs WHERE t.id=cs."tireId" AND t."companyId"=$1 AND t."kilometrosRecorridos">0`, cid);
    await prisma.$executeRawUnsafe(`UPDATE "Tire" SET "currentCpk"=NULL WHERE "companyId"=$1 AND "currentCpk">500`, cid);
    // Peer-mean dim fill
    const peer1 = await prisma.tire.findMany({ where: { companyId: cid, currentCpk: null }, select: { id: true, dimension: true } });
    for (const t of peer1) {
      const cpk = peerCpkMap.get(String(t.dimension || '').toUpperCase().trim()) || globalCpk;
      if (!cpk) continue;
      await prisma.tire.update({ where: { id: t.id }, data: { currentCpk: cpk } });
    }

    // 5. Mirror cpk to inspections + recompute projections
    await prisma.$executeRawUnsafe(`UPDATE inspecciones SET cpk=t."currentCpk" FROM "Tire" t WHERE inspecciones."tireId"=t.id AND t."companyId"=$1 AND t."currentCpk" IS NOT NULL`, cid);
    await prisma.$executeRawUnsafe(`UPDATE inspecciones i SET "cpkProyectado" = ROUND((t."currentCpk" * GREATEST((t."profundidadInicial" - t."currentProfundidad")/NULLIF(t."profundidadInicial",0), 0))::numeric, 2)::double precision FROM "Tire" t WHERE i."tireId"=t.id AND t."companyId"=$1 AND t."currentCpk" IS NOT NULL AND t."profundidadInicial">0 AND t."currentProfundidad" IS NOT NULL`, cid);
    await prisma.$executeRawUnsafe(`UPDATE inspecciones i SET "kmProyectado" = LEAST(t."kilometrosRecorridos"::double precision * t."profundidadInicial"/NULLIF(t."profundidadInicial"-t."currentProfundidad",0), 250000) FROM "Tire" t WHERE i."tireId"=t.id AND t."companyId"=$1 AND t."kilometrosRecorridos">0 AND t."profundidadInicial">0 AND t."currentProfundidad" IS NOT NULL AND t."profundidadInicial">t."currentProfundidad"`, cid);
    // Cap any old huge values
    await prisma.$executeRawUnsafe(`UPDATE inspecciones SET "kmProyectado"=250000 WHERE "kmProyectado">250000 AND "tireId" IN (SELECT id FROM "Tire" WHERE "companyId"=$1)`, cid);
    // Peer-mean fill for null kmProyectado
    const ips = await prisma.$queryRaw<any[]>`
      SELECT i.id, t.dimension FROM inspecciones i JOIN "Tire" t ON t.id=i."tireId"
       WHERE t."companyId"=${cid} AND i."kmProyectado" IS NULL`;
    for (const ip of ips) {
      const v = peerKmProyMap.get(String(ip.dimension || '').toUpperCase().trim()) || globalKmProy;
      if (!v) continue;
      await prisma.inspeccion.update({ where: { id: ip.id }, data: { kmProyectado: v } });
    }

    const r: any[] = await prisma.$queryRaw`
      SELECT
        (SELECT COUNT(*)::int FROM "Tire" WHERE "companyId"=${cid}) tires,
        (SELECT COUNT(*)::int FROM "Tire" WHERE "companyId"=${cid} AND "currentCpk" IS NOT NULL) cpk,
        (SELECT COUNT(*)::int FROM "Tire" WHERE "companyId"=${cid} AND "currentProfundidad" IS NOT NULL) depth,
        (SELECT COUNT(DISTINCT "tireId")::int FROM tire_eventos e WHERE e.tipo='montaje' AND e."tireId" IN (SELECT id FROM "Tire" WHERE "companyId"=${cid})) vida`;
    console.log(' ', JSON.stringify(r[0]));
  }
  console.log('\n✅ Done.');
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
