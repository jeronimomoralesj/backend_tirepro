/**
 * Generalized version of adispetrol-rich-replay.ts that targets EVERY
 * Remax-distributor client. Excel rows are routed to whichever Remax
 * client owns a vehicle whose plate matches the row's PLACA.
 *
 * Strict scope: only Remax-distributor clients get updated. Other
 * distributors' (e.g. Merquellantas) clients stay untouched even if a
 * placa coincidentally matches.
 *
 * Behavior is otherwise identical to the Adispetrol script: rich tire
 * fields, real cost from Precio Unit Sin Iva, full inspection history,
 * cpk + cpkProyectado + kmProyectado recomputed, capped at 500 COP/km.
 *
 *   npx ts-node scripts/remax-rich-replay.ts --apply
 */
import { PrismaClient, EjeType, VidaValue } from '@prisma/client';
import * as fs from 'fs';
const XLSX = require('xlsx');
const prisma = new PrismaClient();

const REMAX_DISTRIBUTOR_ID = '8be67ba6-2345-428a-846c-1248d6bbc15a';
const EXCEL_PATH = '/Users/jeronimo/Downloads/INFORMACION REMAX.xlsx';
const APPLY = process.argv.includes('--apply');

function parseDate(s: any): Date | null {
  if (!s) return null;
  const str = String(s).trim();
  if (!str) return null;
  if (/^\d+(\.\d+)?$/.test(str)) {
    const n = Number(str);
    return new Date(Math.round((n - 25569) * 86400 * 1000));
  }
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}
function num(s: any, dflt = 0): number {
  if (s == null || s === '') return dflt;
  const n = parseFloat(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : dflt;
}
function mapVida(nuevaReencauche: string, banda: string): VidaValue {
  const t = String(nuevaReencauche || '').trim().toUpperCase();
  if (t === 'R' || (banda && banda.trim())) return VidaValue.reencauche1;
  return VidaValue.nueva;
}
function mapEje(eje: string): EjeType {
  const e = String(eje || '').trim().toLowerCase();
  if (e.startsWith('direc')) return EjeType.direccion;
  if (e.startsWith('trac'))  return EjeType.traccion;
  if (e.startsWith('rem')  || e.startsWith('arr')) return EjeType.remolque;
  return EjeType.libre;
}

async function main() {
  console.log(APPLY ? '▶ APPLY' : '◇ DRY-RUN');

  if (!fs.existsSync(EXCEL_PATH)) throw new Error(`Excel not found: ${EXCEL_PATH}`);
  const wb = XLSX.readFile(EXCEL_PATH);
  const rows: any[] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { raw: false, defval: '' });
  console.log(`Excel rows: ${rows.length}`);

  // Get all Remax-distributor client companyIds
  const remaxLinks = await prisma.distributorAccess.findMany({
    where: { distributorId: REMAX_DISTRIBUTOR_ID },
    select: { companyId: true },
  });
  const remaxCompanyIds = remaxLinks.map((l) => l.companyId);
  console.log(`Remax-distributor clients: ${remaxCompanyIds.length}`);

  // Pre-load all Remax vehicles + tires
  const vehicles = await prisma.vehicle.findMany({
    where: { companyId: { in: remaxCompanyIds } },
    select: { id: true, placa: true, companyId: true, kilometrajeActual: true },
  });
  // Map: placa → first vehicle that has it (Remax clients shouldn't share plates)
  const vehByPlate = new Map<string, typeof vehicles[number]>();
  for (const v of vehicles) {
    const k = v.placa.toLowerCase().replace(/\s+/g, '');
    if (!vehByPlate.has(k)) vehByPlate.set(k, v);
  }
  console.log(`Remax vehicles indexed: ${vehByPlate.size}`);

  const tires = await prisma.tire.findMany({
    where: { companyId: { in: remaxCompanyIds }, vehicleId: { not: null } },
    select: { id: true, vehicleId: true, posicion: true, companyId: true },
  });
  const tireByVP = new Map<string, typeof tires[number]>();
  for (const t of tires) tireByVP.set(`${t.vehicleId}|${t.posicion}`, t);
  console.log(`Remax mounted tires: ${tireByVP.size}`);

  // Group rows by tire slot
  type Slot = {
    tireId: string;
    companyId: string | null;
    veh: typeof vehicles[number];
    pos: number;
    rows: any[];
  };
  const slots = new Map<string, Slot>();
  let unmatched = 0;
  for (const row of rows) {
    const placaRaw = String(row.PLACA || '').toLowerCase().replace(/\s+/g, '');
    const pos = parseInt(String(row.Posicion || '0'), 10);
    const veh = vehByPlate.get(placaRaw);
    if (!veh || !pos) { unmatched++; continue; }
    const tire = tireByVP.get(`${veh.id}|${pos}`);
    if (!tire) { unmatched++; continue; }
    const key = `${veh.id}|${pos}`;
    if (!slots.has(key)) slots.set(key, { tireId: tire.id, companyId: tire.companyId, veh, pos, rows: [] });
    slots.get(key)!.rows.push(row);
  }
  console.log(`Slots matched across all Remax clients: ${slots.size}`);
  console.log(`Excel rows unmatched: ${unmatched}`);

  // Per-company tally
  const perCompany: Record<string, number> = {};
  for (const s of slots.values()) {
    const k = s.companyId ?? 'unknown';
    perCompany[k] = (perCompany[k] ?? 0) + s.rows.length;
  }
  for (const [cid, n] of Object.entries(perCompany)) {
    const co = await prisma.company.findUnique({ where: { id: cid }, select: { name: true } });
    console.log(`  ${co?.name ?? cid}: ${n} rows across ${[...slots.values()].filter((s) => s.companyId === cid).length} tires`);
  }

  if (!APPLY) { await prisma.$disconnect(); return; }

  let tiresUpdated = 0, inspsCreated = 0, costosCreated = 0;
  for (const slot of slots.values()) {
    slot.rows.sort((a, b) => {
      const da = parseDate(a['Fecha Inspeccion'])?.getTime() ?? 0;
      const db = parseDate(b['Fecha Inspeccion'])?.getTime() ?? 0;
      return da - db;
    });
    const latest = slot.rows[slot.rows.length - 1];
    const dial         = String(latest.ID || '').trim();
    const marca        = String(latest.Marca || '').trim();
    const diseno       = String(latest['Diseño'] || latest.Diseño || '').trim();
    const dimension    = String(latest.Dimension || '').trim();
    const banda        = String(latest['Banda Reencauche'] || '').trim();
    const profOrig     = num(latest['Prof. Original']);
    const kmRecorrido  = num(latest['Km  Recorrido'] || latest['Km Recorrido']);
    const fechaMontaje = parseDate(latest['Fecha Montaje']);
    const precioUnit   = num(latest['Precio Unit Sin  Iva'] || latest['Precio Unit Sin Iva']);
    const vida         = mapVida(String(latest['Nueva/Reencauche'] || ''), banda);

    await prisma.tire.update({
      where: { id: slot.tireId },
      data: {
        ...(dial      ? { placa: dial } : {}),
        ...(marca     ? { marca } : {}),
        ...(diseno    ? { diseno: banda || diseno } : {}),
        ...(dimension ? { dimension } : {}),
        eje: mapEje(String(latest.Eje || '')),
        vidaActual: vida,
        totalVidas: vida === VidaValue.nueva ? 0 : 1,
        ...(profOrig  ? { profundidadInicial: profOrig } : {}),
        ...(fechaMontaje ? { fechaInstalacion: fechaMontaje } : {}),
        kilometrosRecorridos: Math.min(Math.max(0, Math.round(kmRecorrido)), 250000),
      },
    });
    tiresUpdated++;

    if (precioUnit > 0) {
      await prisma.tireCosto.deleteMany({
        where: { tireId: slot.tireId, concepto: { in: ['adispetrol_excel_cost', 'remax_excel_cost', 'compra_nueva_estimated', 'reencauche_estimated'] } },
      });
      await prisma.tireCosto.create({
        data: {
          tireId: slot.tireId,
          valor: Math.round(precioUnit),
          fecha: fechaMontaje ?? new Date(),
          concepto: 'remax_excel_cost',
        },
      });
      costosCreated++;
    }

    await prisma.inspeccion.deleteMany({
      where: {
        tireId: slot.tireId,
        OR: [
          { externalSourceId: { startsWith: 'synthetic:' } },
          { externalSourceId: { startsWith: 'adispetrol:excel:' } },
          { externalSourceId: { startsWith: 'adispetrol:rich:' } },
          { externalSourceId: { startsWith: 'remax:rich:' } },
          { externalSourceId: { startsWith: 'merquepro:insp:synthetic:' } },
        ],
      },
    });

    for (const row of slot.rows) {
      const fecha = parseDate(row['Fecha Inspeccion']);
      if (!fecha) continue;
      const ext  = num(row.EXT, 0);
      const cen  = num(row.CEN, 0);
      const int_ = num(row.INT, 0);
      const psi  = num(row['Psi\r\nEncontrada'] || row['Psi Encontrada']);
      const kmA  = num(row['Km Actual']);
      const kmR  = num(row['Km  Recorrido'] || row['Km Recorrido']);
      const cap  = (n: number) => Math.min(Math.max(0, Math.round(n)), 250000);
      await prisma.inspeccion.create({
        data: {
          tireId: slot.tireId,
          fecha,
          profundidadInt: int_,
          profundidadCen: cen,
          profundidadExt: ext,
          presionPsi: psi || null,
          kmActualVehiculo: kmA ? Math.round(kmA) : (slot.veh.kilometrajeActual || null),
          kilometrosEstimados: kmR ? cap(kmR) : null,
          kmEfectivos: kmR ? cap(kmR) : null,
          vidaAlMomento: mapVida(String(row['Nueva/Reencauche'] || ''), String(row['Banda Reencauche'] || '').trim()),
          externalSourceId: `remax:rich:${slot.tireId}:${fecha.toISOString().slice(0, 10)}:${row.Posicion || ''}`,
          sourceMetadata: { source: 'remax_rich_excel_replay' } as any,
        },
      });
      inspsCreated++;
    }
  }
  console.log(`Tires updated: ${tiresUpdated}  Inspections: ${inspsCreated}  Costos: ${costosCreated}`);

  // Recompute currentCpk + projections for ALL Remax clients
  console.log('Recomputing CPK + projections for all Remax clients…');
  const remaxIds = remaxCompanyIds;
  await prisma.$executeRaw`
    UPDATE "Tire" t
       SET "currentCpk" = ROUND((cs.total / NULLIF(t."kilometrosRecorridos", 0))::numeric, 2)
      FROM (SELECT "tireId", SUM(valor)::numeric AS total FROM tire_costos GROUP BY "tireId") cs
     WHERE t.id = cs."tireId" AND t."companyId" = ANY(${remaxIds}::text[]) AND t."kilometrosRecorridos" > 0`;
  // Cap CPK > 500 (data quality)
  await prisma.$executeRaw`
    UPDATE "Tire" SET "currentCpk" = NULL
     WHERE "companyId" = ANY(${remaxIds}::text[]) AND "currentCpk" > 500`;
  // Sync currentProfundidad + lastInspeccionDate from latest inspection
  await prisma.$executeRaw`
    UPDATE "Tire" tgt
       SET "currentProfundidad" = sub.avg_d,
           "lastInspeccionDate" = sub.fecha,
           "currentPresionPsi"  = COALESCE(sub.psi, tgt."currentPresionPsi")
      FROM (
        SELECT DISTINCT ON ("tireId") "tireId", fecha,
               ("profundidadInt"+"profundidadCen"+"profundidadExt")/3 AS avg_d,
               "presionPsi" AS psi
          FROM inspecciones ORDER BY "tireId", fecha DESC
      ) sub
     WHERE tgt.id = sub."tireId" AND tgt."companyId" = ANY(${remaxIds}::text[])`;
  // Peer-mean for tires with NULL cpk
  await prisma.$executeRaw`
    WITH peer AS (
      SELECT UPPER(TRIM(t.marca)) m, UPPER(TRIM(t.diseno)) d, UPPER(TRIM(t.dimension)) dim,
             ROUND(AVG(t."currentCpk")::numeric, 2)::double precision AS v
        FROM "Tire" t WHERE t."currentCpk" IS NOT NULL AND t."currentCpk" < 500
       GROUP BY 1,2,3 HAVING COUNT(*) >= 3
    )
    UPDATE "Tire" t SET "currentCpk" = peer.v
      FROM peer WHERE peer.m=UPPER(TRIM(t.marca)) AND peer.d=UPPER(TRIM(t.diseno)) AND peer.dim=UPPER(TRIM(t.dimension))
       AND t."companyId" = ANY(${remaxIds}::text[]) AND t."currentCpk" IS NULL`;
  await prisma.$executeRaw`
    WITH peer AS (
      SELECT UPPER(TRIM(t.dimension)) dim, ROUND(AVG(t."currentCpk")::numeric, 2)::double precision AS v
        FROM "Tire" t WHERE t."currentCpk" IS NOT NULL AND t."currentCpk" < 500
       GROUP BY 1 HAVING COUNT(*) >= 3
    )
    UPDATE "Tire" t SET "currentCpk" = peer.v
      FROM peer WHERE peer.dim=UPPER(TRIM(t.dimension))
       AND t."companyId" = ANY(${remaxIds}::text[]) AND t."currentCpk" IS NULL`;
  await prisma.$executeRaw`
    UPDATE "Tire" SET "currentCpk" = (SELECT ROUND(AVG("currentCpk")::numeric, 2) FROM "Tire" WHERE "companyId" = ANY(${remaxIds}::text[]) AND "currentCpk" IS NOT NULL)
     WHERE "companyId" = ANY(${remaxIds}::text[]) AND "currentCpk" IS NULL`;
  // cpkProyectado per inspection
  await prisma.$executeRaw`
    UPDATE inspecciones i
       SET "cpkProyectado" = ROUND((t."currentCpk" * GREATEST(
             (t."profundidadInicial" - t."currentProfundidad") / NULLIF(t."profundidadInicial", 0), 0
           ))::numeric, 2)::double precision
      FROM "Tire" t
     WHERE i."tireId" = t.id AND t."companyId" = ANY(${remaxIds}::text[])
       AND t."currentCpk" IS NOT NULL AND t."profundidadInicial" > 0
       AND t."currentProfundidad" IS NOT NULL`;
  await prisma.$executeRaw`
    UPDATE inspecciones i
       SET "kmProyectado" = LEAST(
         t."kilometrosRecorridos"::double precision * t."profundidadInicial"
           / NULLIF(t."profundidadInicial" - t."currentProfundidad", 0), 500000
       )
      FROM "Tire" t
     WHERE i."tireId" = t.id AND t."companyId" = ANY(${remaxIds}::text[])
       AND t."kilometrosRecorridos" > 0 AND t."profundidadInicial" > 0
       AND t."currentProfundidad" IS NOT NULL
       AND t."profundidadInicial" > t."currentProfundidad"`;
  await prisma.$executeRaw`
    UPDATE inspecciones SET cpk = t."currentCpk"
      FROM "Tire" t WHERE inspecciones."tireId" = t.id AND t."companyId" = ANY(${remaxIds}::text[])
       AND t."currentCpk" IS NOT NULL`;

  console.log('✅ Done.');
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
