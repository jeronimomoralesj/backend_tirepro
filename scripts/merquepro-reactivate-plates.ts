/**
 * Reactivates merquepro vehicles that were wrongly orphaned because their
 * vehicleId wasn't in the "En Operación" set — but another vehicleId for
 * the same plate WAS. Merquellantas reuses vehicleIds across time (one
 * plate → many ids), and our earlier id-based orphan check incorrectly
 * flagged the older ids.
 *
 * What it does:
 *   1. Build the set of currently-active plates from /currentstatevehicles
 *      (state = "En Operación"), using plate as the identity.
 *   2. For every Vehicle with companyId=null + estadoOperacional=fuera_de_operacion
 *      whose plate is in the active set, re-link it: set companyId back to
 *      the company matching its originalClient, and flip state to activo.
 *   3. Same for Tires that inherited orphan status from those vehicles.
 *
 *   npx ts-node scripts/merquepro-reactivate-plates.ts --apply
 */
import { PrismaClient } from '@prisma/client';
import * as fs from 'node:fs';
import * as path from 'node:path';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const DATA_DIR = '/tmp/merquepro';

function cleanPlate(raw: unknown): string {
  if (!raw || typeof raw !== 'string') return '';
  let p = raw.replace(/\s+/g, '').trim();
  const m = p.match(/^[0-9]{1,4}_(.+)$/);
  if (m) p = m[1];
  return p.toUpperCase();
}

function loadAll(prefix: string): any[] {
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.startsWith(prefix) && f.endsWith('.json')).sort();
  const rows: any[] = [];
  for (const f of files) {
    const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf-8'));
    if (Array.isArray(data)) rows.push(...data);
  }
  return rows;
}

async function main() {
  const csv = loadAll('currentstateveh_p');
  const activePlates = new Set<string>();
  for (const r of csv) {
    if (String(r?.state).trim() !== 'En Operación') continue;
    const pl = cleanPlate(r?.plate);
    if (pl) activePlates.add(pl.toLowerCase());
  }
  console.log(`Active plates per /currentstatevehicles: ${activePlates.size}`);

  // Candidates to reactivate
  const candidates: any[] = await prisma.$queryRaw`
    SELECT id, placa, "originalClient", "companyId", "estadoOperacional"
      FROM "Vehicle"
     WHERE "externalSourceId" LIKE 'merquepro:%'
       AND "estadoOperacional" = 'fuera_de_operacion'`;
  console.log(`Currently-orphaned merquepro vehicles: ${candidates.length}`);

  const toReactivate = candidates.filter((c) => activePlates.has(String(c.placa).toLowerCase()));
  console.log(`  of those, with an active plate in source: ${toReactivate.length}`);

  if (!APPLY) {
    console.log('◇ Pass --apply to reactivate. First 10 samples:');
    for (const c of toReactivate.slice(0, 10)) console.log('  ', c.placa, '|', c.originalClient);
    await prisma.$disconnect();
    return;
  }

  // Build originalClient → companyId map
  const clients = [...new Set(toReactivate.map((c) => c.originalClient).filter(Boolean))];
  const companies: any[] = await prisma.$queryRaw`
    SELECT id, name FROM "Company" WHERE id IN (
      SELECT DISTINCT "companyId" FROM "Vehicle"
       WHERE "externalSourceId" LIKE 'merquepro:%' AND "companyId" IS NOT NULL
         AND "originalClient" = ANY(${clients}::text[])
    )`;
  // Fallback: look up companies by name match
  const clientToCompany = new Map<string, string>();
  for (const cli of clients) {
    const hit: any[] = await prisma.$queryRaw`
      SELECT "companyId"::text AS "companyId" FROM "Vehicle"
       WHERE "externalSourceId" LIKE 'merquepro:%'
         AND "originalClient" = ${cli}
         AND "companyId" IS NOT NULL
       LIMIT 1`;
    if (hit[0]?.companyId) clientToCompany.set(cli, hit[0].companyId);
  }
  console.log(`  companies resolved for ${clientToCompany.size} / ${clients.length} originalClient values`);

  let reactivated = 0, merged = 0, skipped = 0;
  for (const c of toReactivate) {
    const cid = clientToCompany.get(c.originalClient);
    if (!cid) { skipped++; continue; }
    const plateLower = String(c.placa).toLowerCase();
    // Is there already an active winner for this (company, plate)?
    const winner: any[] = await prisma.$queryRaw`
      SELECT id FROM "Vehicle"
       WHERE "companyId" = ${cid} AND LOWER(placa) = ${plateLower}
       LIMIT 1`;
    if (winner[0]) {
      // Merge: point every tire from orphan.vehicleId → winner.id, then
      // delete the orphan. Also migrate lastVehicleId references on
      // inventory tires. Finally delete the now-empty orphan row.
      await prisma.$executeRawUnsafe(`
        UPDATE "Tire" SET "vehicleId" = $1 WHERE "vehicleId" = $2
      `, winner[0].id, c.id);
      await prisma.$executeRawUnsafe(`
        UPDATE "Tire" SET "lastVehicleId" = $1 WHERE "lastVehicleId" = $2
      `, winner[0].id, c.id);
      // Inspecciones, pedidos, etc. on the orphan — cascade delete will
      // orphan/clean up via FK. If any FK blocks the delete, null out
      // the orphan's companyId and leave it.
      try {
        await prisma.vehicle.delete({ where: { id: c.id } });
        merged++;
      } catch {
        skipped++;
      }
    } else {
      await prisma.vehicle.update({
        where: { id: c.id },
        data: {
          companyId: cid,
          estadoOperacional: 'activo',
          fueraDeOperacionDesde: null,
        },
      });
      reactivated++;
    }
  }
  console.log(`Vehicles reactivated: ${reactivated}  merged-into-winner: ${merged}  skipped: ${skipped}`);

  // Re-link tires that were orphaned because their host vehicle was
  const tiresFix: number = await prisma.$executeRawUnsafe(`
    UPDATE "Tire" t
       SET "companyId" = v."companyId"
      FROM "Vehicle" v
     WHERE t."vehicleId" = v.id
       AND t."externalSourceId" LIKE 'merquepro:%'
       AND v."externalSourceId" LIKE 'merquepro:%'
       AND v."companyId" IS NOT NULL
       AND t."companyId" IS NULL
  `);
  console.log(`Tires re-linked to company via active vehicle: ${tiresFix}`);

  // Also re-link tires whose lastVehicleId/lastVehiclePlaca identifies an
  // active plate that's now back under a company — these are inventory
  // tires that belong to active fleets.
  const tiresFix2: number = await prisma.$executeRawUnsafe(`
    UPDATE "Tire" t
       SET "companyId" = v."companyId"
      FROM "Vehicle" v
     WHERE t."lastVehicleId" = v.id
       AND t."vehicleId" IS NULL
       AND t."externalSourceId" LIKE 'merquepro:%'
       AND v."externalSourceId" LIKE 'merquepro:%'
       AND v."companyId" IS NOT NULL
       AND t."companyId" IS NULL
  `);
  console.log(`Inventory tires re-linked via lastVehicleId: ${tiresFix2}`);

  await prisma.$disconnect();
  console.log('✅ Done.');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
