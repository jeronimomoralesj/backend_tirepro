/**
 * Replays the rich INFORMACION REMAX.xlsx (4,720 rows) onto Adispetrol.
 *
 * Differences vs adispetrol-replay-excel.ts:
 *   - Uses "Km Recorrido" directly for tire-life km (not Km Actual − Km
 *     Montaje, which can be wrong).
 *   - Creates tire_costos rows from "Precio Unit Sin Iva" so currentCpk
 *     becomes a real sum(cost)/km computation, not a peer-mean fallback.
 *   - Uses "Prof. Original" for profundidadInicial (more accurate than
 *     the default 22mm).
 *   - Creates one Inspeccion per Excel row (the file has multiple
 *     inspections per tire = full history).
 *   - Wipes the synthetic + previous-replay inspections so we don't
 *     accumulate dupes; user-entered ones (no externalSourceId prefix
 *     match) are kept.
 *
 *   npx ts-node scripts/adispetrol-rich-replay.ts --apply
 */
import { PrismaClient, EjeType, VidaValue } from '@prisma/client';
import * as fs from 'fs';
const XLSX = require('xlsx');
const prisma = new PrismaClient();

const COMPANY_ID = '9f958ac8-39a3-4012-9695-a2e96ae9aee9';
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

  // Pre-load Adispetrol vehicles
  let vehicles = await prisma.vehicle.findMany({
    where: { companyId: COMPANY_ID },
    select: { id: true, placa: true, kilometrajeActual: true },
  });
  const vehByPlate = new Map<string, typeof vehicles[number]>();
  for (const v of vehicles) vehByPlate.set(v.placa.toLowerCase().replace(/\s+/g, ''), v);

  // Auto-create vehicles for placas in Excel that don't yet exist under
  // Adispetrol. The big INFORMACION REMAX Excel is the authoritative
  // Adispetrol fleet snapshot (472 placas). Skip placas that already
  // belong to OTHER companies (don't poach them).
  const placasInExcel = new Set<string>();
  const placaToTipoVhc = new Map<string, string>();
  const placaToKm      = new Map<string, number>();
  for (const row of rows) {
    const p = String(row.PLACA || '').toLowerCase().replace(/\s+/g, '');
    if (!p) continue;
    placasInExcel.add(p);
    if (!placaToTipoVhc.has(p)) placaToTipoVhc.set(p, String(row.Tipologia || '').trim().toLowerCase() || 'otro');
    const km = num(row['Km Actual']);
    if (km > (placaToKm.get(p) ?? 0)) placaToKm.set(p, km);
  }
  let vehCreated = 0, vehSkipped = 0;
  for (const placa of placasInExcel) {
    if (vehByPlate.has(placa)) continue;
    // Check if placa belongs to another company before creating
    const otherCo: any[] = await prisma.$queryRaw`
      SELECT id FROM "Vehicle" WHERE LOWER(REPLACE(placa, ' ', '')) = ${placa} AND "companyId" IS NOT NULL LIMIT 1`;
    if (otherCo.length > 0) { vehSkipped++; continue; }
    if (!APPLY) { vehCreated++; continue; }
    const created = await prisma.vehicle.create({
      data: {
        companyId: COMPANY_ID,
        placa,
        tipovhc: placaToTipoVhc.get(placa) || 'otro',
        kilometrajeActual: Math.min(placaToKm.get(placa) ?? 0, 2_000_000),
        carga: 'seca',
        pesoCarga: 0,
        originalClient: 'ADISPETROL SA',
        sourceMetadata: { source: 'created_from_INFORMACION_REMAX_excel' } as any,
      },
      select: { id: true, placa: true, kilometrajeActual: true },
    });
    vehByPlate.set(placa, created);
    vehCreated++;
  }
  console.log(`Vehicles auto-created: ${vehCreated}  skipped (other company): ${vehSkipped}`);
  vehicles = [...vehByPlate.values()];

  let tireRows = await prisma.tire.findMany({
    where: { companyId: COMPANY_ID, vehicleId: { not: null } },
    select: { id: true, vehicleId: true, posicion: true },
  });
  const tireByVP = new Map<string, typeof tireRows[number]>();
  for (const t of tireRows) tireByVP.set(`${t.vehicleId}|${t.posicion}`, t);
  console.log(`Adispetrol vehicles: ${vehicles.length}, tires: ${tireRows.length}, mounted by position: ${tireByVP.size}`);

  // Auto-create tires for slots in Excel that don't have one in DB yet.
  if (APPLY) {
    let tCreated = 0;
    const seenSlot = new Set<string>();
    for (const row of rows) {
      const p = String(row.PLACA || '').toLowerCase().replace(/\s+/g, '');
      const pos = parseInt(String(row.Posicion || '0'), 10);
      const veh = vehByPlate.get(p);
      if (!veh || !pos) continue;
      const k = `${veh.id}|${pos}`;
      if (seenSlot.has(k)) continue;
      seenSlot.add(k);
      if (tireByVP.has(k)) continue;
      const dial = String(row.ID || '').trim() || `${p}-${pos}`;
      const banda = String(row['Banda Reencauche'] || '').trim();
      const created = await prisma.tire.create({
        data: {
          companyId: COMPANY_ID,
          vehicleId: veh.id,
          placa: dial,
          marca: String(row.Marca || 'DESCONOCIDA').trim(),
          diseno: (banda || String(row['Diseño'] || row.Diseño || 'N/A').trim()) || 'N/A',
          dimension: String(row.Dimension || 'N/A').trim(),
          eje: mapEje(String(row.Eje || '')),
          posicion: pos,
          profundidadInicial: num(row['Prof. Original']) || 22,
          vidaActual: mapVida(String(row['Nueva/Reencauche'] || ''), banda),
          totalVidas: 0,
          kilometrosRecorridos: 0,
          fechaInstalacion: parseDate(row['Fecha Montaje']) ?? new Date(),
          sourceMetadata: { source: 'created_from_INFORMACION_REMAX_excel' } as any,
        },
        select: { id: true, vehicleId: true, posicion: true },
      });
      tireByVP.set(k, created);
      tCreated++;
    }
    console.log(`Tires auto-created: ${tCreated}`);
  }

  // Aggregate Excel rows per tire-slot. The latest mount-date row defines
  // the tire's core fields (placa, marca, diseno, vida, profundidadInicial,
  // cost). All rows for that slot become inspection rows.
  type Slot = {
    tireId: string;
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
    if (!slots.has(key)) slots.set(key, { tireId: tire.id, veh, pos, rows: [] });
    slots.get(key)!.rows.push(row);
  }
  console.log(`Slots matched: ${slots.size}  Excel rows unmatched: ${unmatched}`);

  if (!APPLY) {
    console.log('Dry-run done. Run with --apply.');
    await prisma.$disconnect();
    return;
  }

  let tiresUpdated = 0, inspsCreated = 0, costosCreated = 0;
  for (const slot of slots.values()) {
    // Sort rows oldest-first for inspections; the LAST mount-date row is
    // the current state.
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

    // 1. Update tire core
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

    // 2. Cost: one tire_costos per tire (not per inspection). Replace any
    //    existing migrated/estimated cost so currentCpk is honest.
    if (precioUnit > 0) {
      await prisma.tireCosto.deleteMany({
        where: { tireId: slot.tireId, concepto: { in: ['adispetrol_excel_cost', 'compra_nueva_estimated', 'reencauche_estimated'] } },
      });
      await prisma.tireCosto.create({
        data: {
          tireId: slot.tireId,
          valor: Math.round(precioUnit),
          fecha: fechaMontaje ?? new Date(),
          concepto: 'adispetrol_excel_cost',
        },
      });
      costosCreated++;
    }

    // 3. Wipe synthetic + previous-replay inspections; keep user-entered.
    await prisma.inspeccion.deleteMany({
      where: {
        tireId: slot.tireId,
        OR: [
          { externalSourceId: { startsWith: 'synthetic:' } },
          { externalSourceId: { startsWith: 'adispetrol:excel:' } },
          { externalSourceId: { startsWith: 'merquepro:insp:synthetic:' } },
        ],
      },
    });

    // 4. Create one inspection per Excel row.
    let inspIdx = 0;
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
      inspIdx++;
      try { const insp = await prisma.inspeccion.create({
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
          externalSourceId: `adispetrol:rich:${slot.tireId}:${fecha.toISOString().slice(0, 10)}:${row.Posicion || ''}:${inspIdx}`,
          sourceMetadata: { source: 'adispetrol_rich_excel_replay' } as any,
        },
        select: { id: true },
      });
      inspsCreated++;
      } catch (err: any) { if (err?.code !== 'P2002') throw err; }
    }
  }

  console.log(`Tires updated: ${tiresUpdated}  Inspections created: ${inspsCreated}  Costos: ${costosCreated}`);

  // 5. Recompute currentCpk = sum(costos) / km, then mirror to inspections.
  console.log('Recomputing CPK + projections…');
  await prisma.$executeRawUnsafe(`
    UPDATE "Tire" t
       SET "currentCpk" = ROUND((cs.total / NULLIF(t."kilometrosRecorridos", 0))::numeric, 2)
      FROM (SELECT "tireId", SUM(valor)::numeric AS total FROM tire_costos GROUP BY "tireId") cs
     WHERE t.id = cs."tireId" AND t."companyId" = $1 AND t."kilometrosRecorridos" > 0
  `, COMPANY_ID);
  // Sync currentProfundidad + lastInspeccionDate from latest inspection
  await prisma.$executeRawUnsafe(`
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
     WHERE tgt.id = sub."tireId" AND tgt."companyId" = $1
  `, COMPANY_ID);
  // cpkProyectado per inspection
  await prisma.$executeRawUnsafe(`
    UPDATE inspecciones i
       SET "cpkProyectado" = ROUND((t."currentCpk" * GREATEST(
             (t."profundidadInicial" - t."currentProfundidad") / NULLIF(t."profundidadInicial", 0), 0
           ))::numeric, 2)::double precision
      FROM "Tire" t
     WHERE i."tireId" = t.id AND t."companyId" = $1
       AND t."currentCpk" IS NOT NULL AND t."profundidadInicial" > 0
       AND t."currentProfundidad" IS NOT NULL
  `, COMPANY_ID);
  await prisma.$executeRawUnsafe(`
    UPDATE inspecciones i
       SET "kmProyectado" = LEAST(
         t."kilometrosRecorridos"::double precision * t."profundidadInicial"
           / NULLIF(t."profundidadInicial" - t."currentProfundidad", 0), 500000
       )
      FROM "Tire" t
     WHERE i."tireId" = t.id AND t."companyId" = $1
       AND t."kilometrosRecorridos" > 0 AND t."profundidadInicial" > 0
       AND t."currentProfundidad" IS NOT NULL
       AND t."profundidadInicial" > t."currentProfundidad"
  `, COMPANY_ID);
  await prisma.$executeRawUnsafe(`
    UPDATE inspecciones SET cpk = t."currentCpk"
      FROM "Tire" t
     WHERE inspecciones."tireId" = t.id AND t."companyId" = $1
       AND t."currentCpk" IS NOT NULL
  `, COMPANY_ID);

  console.log('✅ Done.');
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
