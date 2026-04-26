/**
 * Replays the Adispetrol Excel ("informacion actualizada remax") onto the
 * current Adispetrol tires:
 *   - Matches each row to a Tire by (vehicle.placa, position).
 *   - Updates the tire's marca / diseno / dimension / placa(=Excel ID) /
 *     profundidadInicial / fechaInstalacion / vidaActual.
 *   - Replaces all synthetic inspections (externalSourceId LIKE 'synthetic:%')
 *     for that tire with one real inspection holding the Excel depths.
 *   - Real inspections (those NOT prefixed 'synthetic:') are left alone —
 *     additive only, no destruction of user-entered data.
 *
 *   npx ts-node scripts/adispetrol-replay-excel.ts --apply
 */
import { PrismaClient, EjeType, VidaValue } from '@prisma/client';
import * as fs from 'fs';
const XLSX = require('xlsx');
const prisma = new PrismaClient();

const COMPANY_ID = '9f958ac8-39a3-4012-9695-a2e96ae9aee9';
const EXCEL_PATH = '/Users/jeronimo/Downloads/informacion actualizada remax 2.xlsx';
const APPLY = process.argv.includes('--apply');

// Excel "Fecha Inspeccion" comes through as either an ISO-ish string or an
// Excel serial number. Handle both.
function parseDate(s: any): Date | null {
  if (!s) return null;
  if (typeof s === 'number' || /^\d+(\.\d+)?$/.test(String(s))) {
    const n = Number(s);
    // Excel serial date: days since 1899-12-30
    return new Date(Math.round((n - 25569) * 86400 * 1000));
  }
  const d = new Date(String(s));
  return isNaN(d.getTime()) ? null : d;
}

function mapVidaFromExcel(nuevaReencauche: string, banda: string): VidaValue {
  const t = String(nuevaReencauche || '').trim().toUpperCase();
  // 'N' = nueva, 'R' = reencauche
  if (t === 'R' || banda) return VidaValue.reencauche1;
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

  // Pre-load all Adispetrol vehicles + tires
  const vehicles = await prisma.vehicle.findMany({
    where: { companyId: COMPANY_ID },
    select: { id: true, placa: true, kilometrajeActual: true },
  });
  const vehByPlate = new Map<string, typeof vehicles[number]>();
  for (const v of vehicles) vehByPlate.set(v.placa.toLowerCase().replace(/\s+/g, ''), v);
  console.log(`Adispetrol vehicles: ${vehicles.length}`);

  const tires = await prisma.tire.findMany({
    where: { companyId: COMPANY_ID },
    select: { id: true, placa: true, vehicleId: true, posicion: true },
  });
  const tireByVehPos = new Map<string, typeof tires[number]>();
  for (const t of tires) {
    if (t.vehicleId && t.posicion) {
      tireByVehPos.set(`${t.vehicleId}|${t.posicion}`, t);
    }
  }
  console.log(`Adispetrol tires currently: ${tires.length}, mounted with position: ${tireByVehPos.size}`);

  let matched = 0, missingVeh = 0, missingTire = 0, updated = 0;
  let inspReplaced = 0, inspKept = 0;

  for (const row of rows) {
    const placaRaw = String(row.PLACA || '').trim().toLowerCase().replace(/\s+/g, '');
    const pos = parseInt(String(row.Posicion || '0'), 10);
    const veh = vehByPlate.get(placaRaw);
    if (!veh) { missingVeh++; continue; }
    if (!pos) { missingTire++; continue; }
    const tire = tireByVehPos.get(`${veh.id}|${pos}`);
    if (!tire) { missingTire++; continue; }
    matched++;

    const fechaInsp = parseDate(row['Fecha Inspeccion']);
    const fechaMontaje = parseDate(row['Fecha Montaje']);
    const ext = parseFloat(String(row.EXT || '0')) || null;
    const cen = parseFloat(String(row.CEN || '0')) || null;
    const int_ = parseFloat(String(row.INT || '0')) || null;
    const psi = parseFloat(String(row['Psi\nEncontrada'] || row['Psi Encontrada'] || '0')) || null;
    const km  = parseFloat(String(row['Km Actual'] || '0')) || null;
    const banda = String(row['Banda Reencauche'] || '').trim();
    const profOrig = parseFloat(String(row['Prof. Original'] || '0')) || null;
    const dial = String(row.ID || '').trim();
    const marca = String(row.Marca || '').trim();
    const diseno = String(row.Diseño || row['Diseño'] || '').trim();
    const dimension = String(row.Dimension || '').trim();

    if (!APPLY) { updated++; continue; }

    // Tire-life km = vehicle odo at inspection − vehicle odo at mount.
    // Excel "Km Actual" is the vehicle's lifetime odometer (often 1M+ on
    // heavy trucks); we don't want that on the Tire row. Cap at 250k as a
    // sanity guard for cases where Km Montaje is 0/missing.
    const kmMontaje = parseFloat(String(row['Km Montaje'] || '0')) || 0;
    const tireLifeKm = km && kmMontaje >= 0
      ? Math.min(Math.max(0, Math.round(km - kmMontaje)), 250000)
      : 0;
    const vida = mapVidaFromExcel(String(row['Nueva/Reencauche'] || ''), banda);

    // 1. Update tire core fields
    await prisma.tire.update({
      where: { id: tire.id },
      data: {
        ...(dial         ? { placa: dial } : {}),
        ...(marca        ? { marca } : {}),
        ...(diseno       ? { diseno: banda || diseno } : {}),
        ...(dimension    ? { dimension } : {}),
        eje: mapEje(String(row.Eje || '')),
        vidaActual: vida,
        totalVidas: vida === VidaValue.nueva ? 0 : 1,
        ...(profOrig     ? { profundidadInicial: profOrig } : {}),
        ...(fechaMontaje ? { fechaInstalacion: fechaMontaje } : {}),
        kilometrosRecorridos: tireLifeKm,
      },
    });

    // 2. Wipe synthetic inspections, keep real ones
    const synthInsps = await prisma.inspeccion.findMany({
      where: {
        tireId: tire.id,
        externalSourceId: { startsWith: 'synthetic:' },
      },
      select: { id: true },
    });
    if (synthInsps.length > 0) {
      await prisma.inspeccion.deleteMany({ where: { id: { in: synthInsps.map((s) => s.id) } } });
      inspReplaced += synthInsps.length;
    }
    const remaining = await prisma.inspeccion.count({ where: { tireId: tire.id } });
    inspKept += remaining;

    // 3. Insert one real inspection from Excel data — only if no inspection
    //    on the same date already exists (avoid duplicating user-entered).
    if (fechaInsp) {
      const dup = await prisma.inspeccion.findFirst({
        where: { tireId: tire.id, fecha: { gte: new Date(fechaInsp.getTime() - 86400000), lte: new Date(fechaInsp.getTime() + 86400000) } },
        select: { id: true },
      });
      if (!dup) {
        await prisma.inspeccion.create({
          data: {
            tireId: tire.id,
            fecha: fechaInsp,
            profundidadInt: int_ ?? 0,
            profundidadCen: cen ?? 0,
            profundidadExt: ext ?? 0,
            presionPsi: psi,
            // kmActualVehiculo IS the vehicle odometer at inspection — keep it
            // raw. kilometrosEstimados / kmEfectivos must be tire-life km
            // (vehicle odo at inspection − vehicle odo at mount), capped 250k.
            kmActualVehiculo: km ? Math.round(km) : (veh.kilometrajeActual || null),
            kilometrosEstimados: tireLifeKm || null,
            kmEfectivos: tireLifeKm || null,
            vidaAlMomento: vida,
            externalSourceId: `adispetrol:excel:${tire.id}:${fechaInsp.toISOString().slice(0,10)}`,
            sourceMetadata: { source: 'adispetrol_excel_replay', row: { ...row } } as any,
          },
        });
      }
    }
    updated++;
  }

  console.log(`\nMatched: ${matched}  missingVeh: ${missingVeh}  missingTire: ${missingTire}`);
  console.log(`Tires updated: ${updated}  Synthetic inspections replaced: ${inspReplaced}  Real inspections kept: ${inspKept}`);

  if (APPLY) {
    // Recompute analytics on Adispetrol via the same waterfall
    console.log('Recomputing CPK / cpkProyectado / kmProyectado for Adispetrol…');
    await prisma.$executeRawUnsafe(`
      UPDATE "Tire" t
         SET "currentCpk" = ROUND((cs.total / NULLIF(t."kilometrosRecorridos", 0))::numeric, 2)
        FROM (SELECT "tireId", SUM(valor)::numeric AS total FROM tire_costos GROUP BY "tireId") cs
       WHERE t.id = cs."tireId" AND t."companyId" = '${COMPANY_ID}' AND t."kilometrosRecorridos" > 0`);
    await prisma.$executeRawUnsafe(`
      UPDATE "Tire" t
         SET "currentProfundidad" = sub.avg_d, "lastInspeccionDate" = sub.fecha
        FROM (
          SELECT DISTINCT ON ("tireId") "tireId",
                 ("profundidadInt"+"profundidadCen"+"profundidadExt")/3 AS avg_d, fecha
            FROM inspecciones ORDER BY "tireId", fecha DESC
        ) sub
       WHERE t.id = sub."tireId" AND t."companyId" = '${COMPANY_ID}'`);
    // cpkProyectado / kmProyectado on inspections
    await prisma.$executeRawUnsafe(`
      UPDATE inspecciones i
         SET "cpkProyectado" = ROUND((t."currentCpk" * GREATEST(
               (t."profundidadInicial" - t."currentProfundidad") / NULLIF(t."profundidadInicial", 0), 0
             ))::numeric, 2)::double precision
        FROM "Tire" t
       WHERE i."tireId" = t.id AND t."companyId" = '${COMPANY_ID}'
         AND t."currentCpk" IS NOT NULL AND t."profundidadInicial" > 0
         AND t."currentProfundidad" IS NOT NULL`);
    await prisma.$executeRawUnsafe(`
      UPDATE inspecciones i
         SET "kmProyectado" = LEAST(
           t."kilometrosRecorridos"::double precision * t."profundidadInicial"
             / NULLIF(t."profundidadInicial" - t."currentProfundidad", 0), 1000000
         )
        FROM "Tire" t
       WHERE i."tireId" = t.id AND t."companyId" = '${COMPANY_ID}'
         AND t."kilometrosRecorridos" > 0 AND t."profundidadInicial" > 0
         AND t."currentProfundidad" IS NOT NULL
         AND t."profundidadInicial" > t."currentProfundidad"`);
    await prisma.$executeRawUnsafe(`
      UPDATE inspecciones SET cpk = "cpkProyectado"
       WHERE cpk IS NULL AND "cpkProyectado" IS NOT NULL
         AND "tireId" IN (SELECT id FROM "Tire" WHERE "companyId" = '${COMPANY_ID}')`);
    console.log('✅ Done.');
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
