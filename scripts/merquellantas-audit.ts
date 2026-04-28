import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const MERQUE = '1cc199e8-354e-4e51-9d62-666c8b68662c';
const REMAX  = '8be67ba6-2345-428a-846c-1248d6bbc15a';

async function main() {
  const merqueLinks = await prisma.distributorAccess.findMany({ where: { distributorId: MERQUE }, select: { companyId: true } });
  const remaxLinks  = await prisma.distributorAccess.findMany({ where: { distributorId: REMAX },  select: { companyId: true } });
  const merqueIds = new Set(merqueLinks.map((l) => l.companyId));
  const remaxIds  = new Set(remaxLinks.map((l) => l.companyId));
  const overlap   = [...merqueIds].filter((id) => remaxIds.has(id));

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  DISTRIBUTOR ACCESS');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`Merquellantas clients: ${merqueIds.size}`);
  console.log(`Remax clients:         ${remaxIds.size}`);
  console.log(`Overlap (both):        ${overlap.length}  ${overlap.length ? '⚠️  needs investigation' : '✓ clean'}`);

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  TIRES — by source / scope');
  console.log('═══════════════════════════════════════════════════════════════════');
  const totalTires = await prisma.tire.count();
  const merqueTires = await prisma.tire.count({ where: { externalSourceId: { startsWith: 'merquepro:tire:' } } });
  const remaxClientTires = remaxIds.size > 0
    ? await prisma.tire.count({ where: { companyId: { in: [...remaxIds] } } })
    : 0;
  const merqueClientTires = merqueIds.size > 0
    ? await prisma.tire.count({ where: { companyId: { in: [...merqueIds] } } })
    : 0;
  const orphanTires = await prisma.tire.count({ where: { companyId: null } });
  const orphanMerqueTires = await prisma.tire.count({ where: { companyId: null, externalSourceId: { startsWith: 'merquepro:tire:' } } });

  console.log(`Total tires in DB:                    ${totalTires.toLocaleString()}`);
  console.log(`  with merquepro: prefix:             ${merqueTires.toLocaleString()}`);
  console.log(`  owned by a Merquellantas client:    ${merqueClientTires.toLocaleString()}`);
  console.log(`  owned by a Remax client:            ${remaxClientTires.toLocaleString()}`);
  console.log(`  orphan (companyId NULL):            ${orphanTires.toLocaleString()}`);
  console.log(`  orphan AND merquepro-source:        ${orphanMerqueTires.toLocaleString()}`);

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  VEHICLES — by source / scope');
  console.log('═══════════════════════════════════════════════════════════════════');
  const totalVeh = await prisma.vehicle.count();
  const merqueVeh = await prisma.vehicle.count({ where: { externalSourceId: { startsWith: 'merquepro:vehicle:' } } });
  const merqueClientVeh = merqueIds.size > 0
    ? await prisma.vehicle.count({ where: { companyId: { in: [...merqueIds] } } })
    : 0;
  const remaxClientVeh = remaxIds.size > 0
    ? await prisma.vehicle.count({ where: { companyId: { in: [...remaxIds] } } })
    : 0;
  const orphanVeh = await prisma.vehicle.count({ where: { companyId: null } });
  const fueraDeOpVeh = await prisma.vehicle.count({ where: { estadoOperacional: 'fuera_de_operacion' } });

  console.log(`Total vehicles in DB:                 ${totalVeh.toLocaleString()}`);
  console.log(`  with merquepro: prefix:             ${merqueVeh.toLocaleString()}`);
  console.log(`  owned by a Merquellantas client:    ${merqueClientVeh.toLocaleString()}`);
  console.log(`  owned by a Remax client:            ${remaxClientVeh.toLocaleString()}`);
  console.log(`  orphan (companyId NULL):            ${orphanVeh.toLocaleString()}`);
  console.log(`  estadoOperacional=fuera_de_op:      ${fueraDeOpVeh.toLocaleString()}`);

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  MERQUELLANTAS DATA QUALITY');
  console.log('═══════════════════════════════════════════════════════════════════');
  const noCpk      = await prisma.tire.count({ where: { externalSourceId: { startsWith: 'merquepro:tire:' }, currentCpk: null } });
  const noVida     = await prisma.tire.count({ where: { externalSourceId: { startsWith: 'merquepro:tire:' }, vidaActual: 'nueva', totalVidas: { gt: 0 } } });
  const ejeLibre   = await prisma.tire.count({ where: { externalSourceId: { startsWith: 'merquepro:tire:' }, eje: 'libre' } });
  const noDimension = await prisma.tire.count({ where: { externalSourceId: { startsWith: 'merquepro:tire:' }, OR: [{ dimension: 'N/A' }, { dimension: '' }] } });
  const dimNonCanonical = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(`
    SELECT COUNT(*)::bigint AS count
      FROM "Tire"
     WHERE "externalSourceId" LIKE 'merquepro:tire:%'
       AND "dimension" <> UPPER(REGEXP_REPLACE("dimension", '\\s+', '', 'g'))
  `);
  const merqueInsps = await prisma.inspeccion.count({ where: { externalSourceId: { startsWith: 'merquepro:insp:' } } });
  const csInsps     = await prisma.inspeccion.count({ where: { externalSourceId: { startsWith: 'merquepro:insp:cs:' } } });
  const synthInsps  = await prisma.inspeccion.count({ where: { externalSourceId: { startsWith: 'merquepro:insp:synthetic:' } } });

  console.log(`Merquepro tires:                                  ${merqueTires.toLocaleString()}`);
  console.log(`  with currentCpk = NULL:                         ${noCpk.toLocaleString()}  (${pct(noCpk, merqueTires)})`);
  console.log(`  vidaActual=nueva but totalVidas>0 (suspicious): ${noVida.toLocaleString()}`);
  console.log(`  eje = 'libre' (no axle inferred):               ${ejeLibre.toLocaleString()}  (${pct(ejeLibre, merqueTires)})`);
  console.log(`  dimension = 'N/A' or '':                        ${noDimension.toLocaleString()}`);
  console.log(`  dimension non-canonical (needs normalize):      ${Number(dimNonCanonical[0].count).toLocaleString()}`);
  console.log(`Merquepro inspections (all):                      ${merqueInsps.toLocaleString()}`);
  console.log(`  per-snapshot (cs:):                             ${csInsps.toLocaleString()}`);
  console.log(`  legacy single-synthetic (synthetic:):           ${synthInsps.toLocaleString()}  ${synthInsps ? '← will be deleted on next --apply' : ''}`);

  if (overlap.length > 0) {
    console.log('\n═══════════════════════════════════════════════════════════════════');
    console.log('  ⚠️  CROSS-DISTRIBUTOR COMPANIES (Merquellantas + Remax)');
    console.log('═══════════════════════════════════════════════════════════════════');
    const dupes = await prisma.company.findMany({
      where: { id: { in: overlap } },
      select: { id: true, name: true, _count: { select: { vehicles: true, tires: true } } },
    });
    for (const c of dupes) {
      console.log(`  ${c.id}  ${c.name.padEnd(40)} vehicles=${c._count.vehicles} tires=${c._count.tires}`);
    }
  }
}

function pct(n: number, total: number): string {
  if (!total) return '0%';
  return `${((n / total) * 100).toFixed(1)}%`;
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
