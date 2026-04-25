/**
 * Restores tires deleted on 2026-04-20 from vehicle_tire_history.
 *
 * The history table preserves marca / diseno / dimension / position /
 * vidaAlMontaje / profundidadInicial / fechaMontaje / vehicleId / companyId
 * for every tire ever mounted, even after the Tire row itself is deleted
 * (tireId becomes NULL on the history row).
 *
 * What it does:
 *   1. For each --client (or all distributor=Remax clients with --remax),
 *      pick orphan history rows (tireId IS NULL).
 *   2. Group by (vehicleId, position) → keep only the LATEST mount per
 *      position (so we don't restore both a dismounted and current tire).
 *   3. Skip if a Tire ALREADY exists at that (vehicleId, position) — never
 *      overwrite. Same for inspections, costs, events: nothing is deleted.
 *   4. Create new native Tire rows (externalSourceId=null) with the history
 *      data and link the history row to the new tire.
 *
 *   npx ts-node scripts/restore-from-history.ts --remax           # all Remax clients
 *   npx ts-node scripts/restore-from-history.ts --client="Adispetrol SA"
 *   npx ts-node scripts/restore-from-history.ts --remax --apply   # actually write
 */
import { PrismaClient, EjeType, VidaValue } from '@prisma/client';
const prisma = new PrismaClient();

const APPLY      = process.argv.includes('--apply');
const REMAX_ALL  = process.argv.includes('--remax');
const ONE_CLIENT = process.argv.find((a) => a.startsWith('--client='))?.slice('--client='.length);
const REMAX_DISTRIBUTOR_ID = '8be67ba6-2345-428a-846c-1248d6bbc15a';

function mapVida(s: string | null): VidaValue {
  const v = (s ?? '').toLowerCase();
  if (v.startsWith('reencauche3')) return VidaValue.reencauche3;
  if (v.startsWith('reencauche2')) return VidaValue.reencauche2;
  if (v.startsWith('reencauche'))  return VidaValue.reencauche1;
  if (v.startsWith('fin') || v === 'desecho') return VidaValue.fin;
  return VidaValue.nueva;
}

async function main() {
  console.log(APPLY ? '▶ APPLY' : '◇ DRY-RUN — pass --apply to actually restore');

  // Pick target companies
  let companyIds: string[] = [];
  if (ONE_CLIENT) {
    const co = await prisma.company.findFirst({
      where: { name: { equals: ONE_CLIENT, mode: 'insensitive' } },
      select: { id: true, name: true },
    });
    if (!co) throw new Error(`Company "${ONE_CLIENT}" not found`);
    companyIds = [co.id];
    console.log(`Target: ${co.name}`);
  } else if (REMAX_ALL) {
    const links = await prisma.distributorAccess.findMany({
      where: { distributorId: REMAX_DISTRIBUTOR_ID },
      select: { companyId: true },
    });
    companyIds = links.map((l) => l.companyId);
    console.log(`Target: ${companyIds.length} Remax-distributor clients`);
  } else {
    console.error('Pass --remax or --client="X"');
    process.exit(1);
  }

  let totalRestored = 0, totalSkippedExists = 0, totalSkippedNoVehicle = 0;

  for (const companyId of companyIds) {
    const co = await prisma.company.findUnique({ where: { id: companyId }, select: { name: true } });
    // Latest mount per (vehicleId, position) for this company's orphan history
    const latest: any[] = await prisma.$queryRaw`
      SELECT DISTINCT ON ("vehicleId", "position")
             id AS hist_id, "vehicleId", "position", marca, diseno, dimension,
             "vidaAlMontaje" AS vida, "profundidadInicial" AS prof_init,
             "fechaMontaje" AS fecha_montaje
        FROM vehicle_tire_history
       WHERE "companyId" = ${companyId}
         AND "tireId" IS NULL
         AND "vehicleId" IS NOT NULL
       ORDER BY "vehicleId", "position", "fechaMontaje" DESC NULLS LAST, "createdAt" DESC
    `;
    if (latest.length === 0) continue;

    let restored = 0, skipExists = 0, skipNoVeh = 0;
    for (const h of latest) {
      // Vehicle must still exist
      const veh = await prisma.vehicle.findUnique({
        where: { id: h.vehicleId },
        select: { id: true, placa: true, companyId: true },
      });
      if (!veh) { skipNoVeh++; continue; }

      // Don't overwrite an existing tire at this slot
      const existing = await prisma.tire.findFirst({
        where: { vehicleId: h.vehicleId, posicion: h.position ?? 0 },
        select: { id: true },
      });
      if (existing) { skipExists++; continue; }

      if (!APPLY) { restored++; continue; }

      // Generate a synthetic placa from vehicle + position so the tire is
      // visible (placa is required, NOT NULL in schema). Format mirrors the
      // bulk-upload pattern: placa = `<vehicle.placa>-<pos>`.
      const placa = `${veh.placa}-${h.position}`;

      const created = await prisma.tire.create({
        data: {
          companyId: veh.companyId,
          vehicleId: veh.id,
          placa,
          marca: (h.marca ?? 'DESCONOCIDA').trim(),
          diseno: (h.diseno ?? 'N/A').trim(),
          dimension: (h.dimension ?? 'N/A').trim(),
          eje: EjeType.libre,
          posicion: h.position ?? 0,
          profundidadInicial: h.prof_init ?? 22,
          vidaActual: mapVida(h.vida),
          totalVidas: 0,
          kilometrosRecorridos: 0,
          fechaInstalacion: h.fecha_montaje ?? new Date(),
          // No externalSourceId — these are native restorations.
          sourceMetadata: { source: 'restored_from_vehicle_tire_history', historyId: h.hist_id } as any,
        },
        select: { id: true },
      });
      // Link the history row back to the new tire
      await prisma.$executeRawUnsafe(
        `UPDATE vehicle_tire_history SET "tireId" = $1 WHERE id = $2`,
        created.id, h.hist_id,
      );
      restored++;
    }
    console.log(`${co?.name ?? companyId}: restored=${restored}  alreadyExists=${skipExists}  noVehicle=${skipNoVeh}`);
    totalRestored += restored;
    totalSkippedExists += skipExists;
    totalSkippedNoVehicle += skipNoVeh;
  }

  console.log(`\nTotal: restored=${totalRestored}  alreadyExists=${totalSkippedExists}  noVehicle=${totalSkippedNoVehicle}`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
