/**
 * Two-step recovery:
 *
 *  1. Restore tires from vehicle_tire_history that couldn't restore in
 *     restore-from-history.ts because their original vehicle is now owned
 *     by another company. They land as INVENTORY (vehicleId=null,
 *     lastVehicleId preserved) on the right company so they show up.
 *
 *  2. Synthesize ONE Inspeccion per restored tire so the UI's CPK / depth /
 *     km columns aren't blank — using mount-time depth from history.
 *     Then fill cpk / cpkProyectado / kmProyectado via peer-mean fallback.
 *
 *   npx ts-node scripts/restore-with-inspections.ts --apply
 */
import { PrismaClient, EjeType, VidaValue } from '@prisma/client';
const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const REMAX = '8be67ba6-2345-428a-846c-1248d6bbc15a';

function mapVida(s: string | null): VidaValue {
  const v = (s ?? '').toLowerCase();
  if (v.startsWith('reencauche3')) return VidaValue.reencauche3;
  if (v.startsWith('reencauche2')) return VidaValue.reencauche2;
  if (v.startsWith('reencauche'))  return VidaValue.reencauche1;
  if (v === 'fin' || v === 'desecho') return VidaValue.fin;
  return VidaValue.nueva;
}

async function main() {
  console.log(APPLY ? '▶ APPLY' : '◇ DRY-RUN');

  const remaxClients: any[] = await prisma.$queryRaw`
    SELECT c.id, c.name FROM "Company" c
      JOIN "DistributorAccess" da ON da."companyId"=c.id AND da."distributorId"=${REMAX}`;
  // ── PASS A: restore as inventory (vehicleId=null) ─────────────────────
  let invRestored = 0;
  for (const co of remaxClients) {
    const orphans: any[] = await prisma.$queryRaw`
      SELECT DISTINCT ON (vth."vehicleId", vth.position, vth.marca, vth.diseno, vth.dimension)
             vth.id AS hist_id, vth."vehicleId", vth.position, vth.marca, vth.diseno, vth.dimension,
             vth."vidaAlMontaje" AS vida, vth."profundidadInicial" AS prof_init,
             vth."fechaMontaje" AS dt, v.placa AS veh_placa
        FROM vehicle_tire_history vth
        LEFT JOIN "Vehicle" v ON v.id = vth."vehicleId"
       WHERE vth."companyId" = ${co.id}
         AND vth."tireId" IS NULL`;
    if (orphans.length === 0) continue;
    let created = 0;
    for (const h of orphans) {
      if (!APPLY) { created++; continue; }
      // Synthetic placa: "<orig_veh_placa>-<pos>-rec" so it's identifiable
      const placa = `${h.veh_placa ?? 'inv'}-${h.position ?? 'x'}-rec`;
      const tire = await prisma.tire.create({
        data: {
          companyId: co.id,
          vehicleId: null,                  // inventory
          lastVehicleId: h.vehicleId,       // preserve provenance
          lastVehiclePlaca: h.veh_placa,
          lastPosicion: h.position,
          inventoryEnteredAt: new Date(),
          placa,
          marca: (h.marca ?? 'DESCONOCIDA').trim(),
          diseno: (h.diseno ?? 'N/A').trim(),
          dimension: (h.dimension ?? 'N/A').trim(),
          eje: EjeType.libre,
          posicion: 0,
          profundidadInicial: h.prof_init ?? 22,
          vidaActual: mapVida(h.vida),
          totalVidas: 0,
          kilometrosRecorridos: 0,
          fechaInstalacion: h.dt ?? new Date(),
          sourceMetadata: { source: 'restored_inventory_from_history', historyId: h.hist_id } as any,
        },
        select: { id: true },
      });
      await prisma.$executeRawUnsafe(
        `UPDATE vehicle_tire_history SET "tireId" = $1 WHERE id = $2`,
        tire.id, h.hist_id,
      );
      created++;
    }
    if (created > 0) console.log(`${co.name}: inventory restored=${created}`);
    invRestored += created;
  }
  console.log(`Total inventory restored: ${invRestored}`);

  if (!APPLY) { await prisma.$disconnect(); return; }

  // ── PASS B: synthesize an inspection per restored tire ────────────────
  // For every Remax-client tire whose sourceMetadata says it was restored
  // from history AND has zero inspections, create one inspection rooted on
  // the mount-time depth.
  const restored: any[] = await prisma.$queryRaw`
    SELECT t.id, t."companyId", t.placa, t."profundidadInicial" AS prof,
           t."fechaInstalacion" AS dt, t."vidaActual" AS vida, t."vehicleId",
           v."kilometrajeActual" AS veh_km
      FROM "Tire" t LEFT JOIN "Vehicle" v ON v.id = t."vehicleId"
     WHERE t."companyId" IN (SELECT "companyId" FROM "DistributorAccess" WHERE "distributorId" = ${REMAX})
       AND t."sourceMetadata"->>'source' IN ('restored_from_vehicle_tire_history', 'restored_inventory_from_history')
       AND NOT EXISTS (SELECT 1 FROM inspecciones i WHERE i."tireId" = t.id)`;
  console.log(`Synthesizing inspections for ${restored.length} restored tires…`);
  let inspCreated = 0;
  for (const t of restored) {
    await prisma.inspeccion.create({
      data: {
        tireId: t.id,
        fecha: t.dt ?? new Date(),
        profundidadInt: t.prof ?? 22,
        profundidadCen: t.prof ?? 22,
        profundidadExt: t.prof ?? 22,
        vidaAlMomento: t.vida,
        kmActualVehiculo: t.veh_km ?? null,
        externalSourceId: `synthetic:restored:${t.id}`,
        sourceMetadata: { source: 'synth_from_restored_tire' } as any,
      },
    });
    inspCreated++;
  }
  console.log(`Inspections synthesized: ${inspCreated}`);

  // ── PASS C: peer-mean fill on cpk / cpkProy / kmProy / kmEfectivos ────
  // Re-use the same waterfall as the merquepro post-pass.
  await prisma.$executeRawUnsafe(`
    WITH peer AS (
      SELECT UPPER(TRIM(t.marca)) m, UPPER(TRIM(t.diseno)) d, UPPER(TRIM(t.dimension)) dim,
             ROUND(AVG(i."cpkProyectado")::numeric, 2)::double precision AS v
        FROM "Tire" t JOIN inspecciones i ON i."tireId"=t.id
       WHERE i."cpkProyectado" IS NOT NULL GROUP BY 1,2,3 HAVING COUNT(*) >= 3
    )
    UPDATE inspecciones i SET "cpkProyectado" = peer.v
      FROM "Tire" t JOIN peer ON peer.m=UPPER(TRIM(t.marca)) AND peer.d=UPPER(TRIM(t.diseno)) AND peer.dim=UPPER(TRIM(t.dimension))
     WHERE i."tireId"=t.id AND i."cpkProyectado" IS NULL
       AND t."companyId" IN (SELECT "companyId" FROM "DistributorAccess" WHERE "distributorId" = '${REMAX}')`);
  await prisma.$executeRawUnsafe(`
    WITH peer AS (
      SELECT UPPER(TRIM(t.dimension)) dim, ROUND(AVG(i."cpkProyectado")::numeric, 2)::double precision AS v
        FROM "Tire" t JOIN inspecciones i ON i."tireId"=t.id
       WHERE i."cpkProyectado" IS NOT NULL GROUP BY 1 HAVING COUNT(*) >= 3
    )
    UPDATE inspecciones i SET "cpkProyectado" = peer.v
      FROM "Tire" t JOIN peer ON peer.dim=UPPER(TRIM(t.dimension))
     WHERE i."tireId"=t.id AND i."cpkProyectado" IS NULL
       AND t."companyId" IN (SELECT "companyId" FROM "DistributorAccess" WHERE "distributorId" = '${REMAX}')`);
  await prisma.$executeRawUnsafe(`
    UPDATE inspecciones i SET cpk = "cpkProyectado" WHERE cpk IS NULL AND "cpkProyectado" IS NOT NULL
       AND "tireId" IN (SELECT id FROM "Tire" WHERE "companyId" IN (SELECT "companyId" FROM "DistributorAccess" WHERE "distributorId" = '${REMAX}'))`);
  await prisma.$executeRawUnsafe(`
    WITH peer AS (
      SELECT UPPER(TRIM(t.marca)) m, UPPER(TRIM(t.diseno)) d, UPPER(TRIM(t.dimension)) dim,
             AVG(i."kmProyectado")::double precision AS v
        FROM "Tire" t JOIN inspecciones i ON i."tireId"=t.id
       WHERE i."kmProyectado" IS NOT NULL GROUP BY 1,2,3 HAVING COUNT(*) >= 3
    )
    UPDATE inspecciones i SET "kmProyectado" = peer.v
      FROM "Tire" t JOIN peer ON peer.m=UPPER(TRIM(t.marca)) AND peer.d=UPPER(TRIM(t.diseno)) AND peer.dim=UPPER(TRIM(t.dimension))
     WHERE i."tireId"=t.id AND i."kmProyectado" IS NULL
       AND t."companyId" IN (SELECT "companyId" FROM "DistributorAccess" WHERE "distributorId" = '${REMAX}')`);
  await prisma.$executeRawUnsafe(`
    WITH peer AS (
      SELECT UPPER(TRIM(t.dimension)) dim, AVG(i."kmProyectado")::double precision AS v
        FROM "Tire" t JOIN inspecciones i ON i."tireId"=t.id
       WHERE i."kmProyectado" IS NOT NULL GROUP BY 1 HAVING COUNT(*) >= 3
    )
    UPDATE inspecciones i SET "kmProyectado" = peer.v
      FROM "Tire" t JOIN peer ON peer.dim=UPPER(TRIM(t.dimension))
     WHERE i."tireId"=t.id AND i."kmProyectado" IS NULL
       AND t."companyId" IN (SELECT "companyId" FROM "DistributorAccess" WHERE "distributorId" = '${REMAX}')`);
  // Mirror cpk/proy onto Tire row
  await prisma.$executeRawUnsafe(`
    UPDATE "Tire" tgt
       SET "currentCpk" = sub.cpk,
           "currentProfundidad" = sub.depth,
           "lastInspeccionDate" = sub.fecha
      FROM (
        SELECT DISTINCT ON ("tireId") "tireId", cpk,
               ("profundidadInt"+"profundidadCen"+"profundidadExt")/3 AS depth, fecha
          FROM inspecciones ORDER BY "tireId", fecha DESC
      ) sub
     WHERE tgt.id = sub."tireId"
       AND tgt."companyId" IN (SELECT "companyId" FROM "DistributorAccess" WHERE "distributorId" = '${REMAX}')`);

  console.log('✅ Done. Remax restored tires now have inspections + CPK projections.');
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
