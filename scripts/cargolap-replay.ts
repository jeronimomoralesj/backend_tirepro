/**
 * One-shot replay for CARGOLAP LOGISTICA from
 * /Users/jeronimo/Downloads/INPECCIONES CARGOLAP 07 DE FEBRERO 2027.xlsx
 *
 * Mirrors what we did for Adispetrol:
 *  1. Auto-create vehicles for placas in Excel that don't exist (and aren't
 *     owned by another company).
 *  2. Auto-create tires per (vehicle, posicion) slot from Excel.
 *  3. Delete CARGOLAP tires whose slot isn't in the Excel.
 *  4. Update tire core fields from Excel + add a real Inspeccion per row.
 *  5. Vida montaje events for every tire.
 *  6. Peer-mean cost so every tire has a CPK.
 *  7. Recompute currentCpk + cpkProyectado + kmProyectado (capped 250k).
 *
 *   npx ts-node scripts/cargolap-replay.ts --apply
 */
import { PrismaClient, EjeType, VidaValue, TireEventType } from '@prisma/client';
import * as fs from 'fs';
const XLSX = require('xlsx');
const prisma = new PrismaClient();

const COMPANY_ID = 'dfe8cb65-ab81-4d00-b410-12f94280c7e0';
const EXCEL_PATH = '/Users/jeronimo/Downloads/INPECCIONES CARGOLAP 07 DE FEBRERO 2027.xlsx';
const APPLY = process.argv.includes('--apply');

function parseDate(s: any): Date | null {
  if (!s) return null;
  const str = String(s).trim();
  if (!str) return null;
  if (/^\d+(\.\d+)?$/.test(str)) {
    return new Date(Math.round((Number(str) - 25569) * 86400 * 1000));
  }
  const d = new Date(str);
  if (isNaN(d.getTime())) {
    // Try DD/MM/YY
    const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (m) {
      const yr = parseInt(m[3], 10);
      return new Date(yr < 100 ? 2000 + yr : yr, parseInt(m[2], 10) - 1, parseInt(m[1], 10));
    }
    return null;
  }
  return d;
}
function num(s: any, dflt = 0): number {
  if (s == null || s === '') return dflt;
  const n = parseFloat(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : dflt;
}
function mapVida(s: string): VidaValue {
  const v = (s || '').trim().toUpperCase();
  if (v.startsWith('REENCAUCHE3')) return VidaValue.reencauche3;
  if (v.startsWith('REENCAUCHE2')) return VidaValue.reencauche2;
  if (v.startsWith('REENCAUCHE'))  return VidaValue.reencauche1;
  return VidaValue.nueva;
}
function mapEje(t: string, posicion: number): EjeType {
  const e = (t || '').trim().toLowerCase();
  if (e.startsWith('direc')) return EjeType.direccion;
  if (e.startsWith('trac'))  return EjeType.traccion;
  if (e.startsWith('rem')||e.startsWith('arr')) return EjeType.remolque;
  if (posicion === 1 || posicion === 2) return EjeType.direccion;
  return EjeType.libre;
}

async function main() {
  console.log(APPLY ? '▶ APPLY' : '◇ DRY-RUN');
  if (!fs.existsSync(EXCEL_PATH)) throw new Error(`Excel not found: ${EXCEL_PATH}`);
  const wb = XLSX.readFile(EXCEL_PATH);
  const rows: any[] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { raw: false, defval: '' });
  console.log(`Excel rows: ${rows.length}`);

  // Pre-load
  let vehicles = await prisma.vehicle.findMany({ where: { companyId: COMPANY_ID }, select: { id: true, placa: true, kilometrajeActual: true } });
  const vehByPlate = new Map<string, typeof vehicles[number]>();
  for (const v of vehicles) vehByPlate.set(v.placa.toLowerCase().replace(/\s+/g, ''), v);

  // 1. Auto-create vehicles from Excel
  const excelPlacas = new Set<string>();
  const tipoByPlaca = new Map<string, string>();
  const kmByPlaca = new Map<string, number>();
  for (const r of rows) {
    const p = String(r['Placa '] || r.Placa || '').trim().toLowerCase().replace(/\s+/g, '');
    if (!p) continue;
    excelPlacas.add(p);
    tipoByPlaca.set(p, String(r['Tipo de Equipo'] || '').trim().toLowerCase() || 'otro');
    const km = num(r['Km  Actual']);
    if (km > (kmByPlaca.get(p) ?? 0)) kmByPlaca.set(p, km);
  }
  let vehCreated = 0;
  for (const placa of excelPlacas) {
    if (vehByPlate.has(placa)) continue;
    const otherCo: any[] = await prisma.$queryRaw`SELECT id FROM "Vehicle" WHERE LOWER(REPLACE(placa,' ','')) = ${placa} AND "companyId" IS NOT NULL LIMIT 1`;
    if (otherCo.length > 0) continue;
    if (!APPLY) { vehCreated++; continue; }
    const created = await prisma.vehicle.create({
      data: {
        companyId: COMPANY_ID,
        placa,
        tipovhc: tipoByPlaca.get(placa) || 'otro',
        kilometrajeActual: Math.min(kmByPlaca.get(placa) ?? 0, 2_000_000),
        carga: 'seca',
        pesoCarga: 0,
        originalClient: 'CARGOLAP LOGISTICA S.A.',
        sourceMetadata: { source: 'created_from_cargolap_excel' } as any,
      },
      select: { id: true, placa: true, kilometrajeActual: true },
    });
    vehByPlate.set(placa, created);
    vehCreated++;
  }
  console.log(`Vehicles auto-created: ${vehCreated}`);
  vehicles = [...vehByPlate.values()];

  // 2. Pre-load tires
  const tires = await prisma.tire.findMany({ where: { companyId: COMPANY_ID, vehicleId: { not: null } }, select: { id: true, vehicleId: true, posicion: true } });
  const tireByVP = new Map<string, typeof tires[number]>();
  for (const t of tires) tireByVP.set(`${t.vehicleId}|${t.posicion}`, t);

  if (APPLY) {
    // Auto-create tires from Excel rows that don't have one
    let tCreated = 0;
    for (const row of rows) {
      const p = String(row['Placa '] || row.Placa || '').trim().toLowerCase().replace(/\s+/g, '');
      const pos = parseInt(String(row.Pos || '0'), 10);
      const veh = vehByPlate.get(p);
      if (!veh || !pos) continue;
      const k = `${veh.id}|${pos}`;
      if (tireByVP.has(k)) continue;
      const dial = String(row['# numero de llanta'] || '').trim() || `${p}-${pos}`;
      const banda = String(row.Banda || '').trim();
      const created = await prisma.tire.create({
        data: {
          companyId: COMPANY_ID, vehicleId: veh.id, placa: dial.toLowerCase() === 'no aplica' ? `${p}-${pos}` : dial,
          marca: String(row.Marca || 'DESCONOCIDA').trim(),
          diseno: ((banda && banda.toLowerCase() !== 'original') || String(row['Marca Band']||'').toLowerCase().includes('reencauche')
            ? banda : String(row['Diseño'] || '').trim()) || 'N/A',
          dimension: String(row['Dimensión '] || row['Dimensión'] || '').trim() || 'N/A',
          eje: mapEje(String(row['Tipo Llanta'] || ''), pos),
          posicion: pos,
          profundidadInicial: num(row['Prf  Int']) || 22,
          vidaActual: mapVida(String(row.Vida || '')),
          totalVidas: 0,
          kilometrosRecorridos: 0,
          fechaInstalacion: parseDate(row['Fecha Ult Ins']) ?? new Date(),
          sourceMetadata: { source: 'created_from_cargolap_excel' } as any,
        },
        select: { id: true, vehicleId: true, posicion: true },
      });
      tireByVP.set(k, created);
      tCreated++;
    }
    console.log(`Tires auto-created: ${tCreated}`);
  }

  // 3. Delete extras (CARGOLAP tires whose slot isn't in Excel)
  const excelSlots = new Set<string>();
  for (const r of rows) {
    const p = String(r['Placa '] || r.Placa || '').trim().toLowerCase().replace(/\s+/g, '');
    const pos = parseInt(String(r.Pos || '0'), 10);
    const veh = vehByPlate.get(p);
    if (veh && pos) excelSlots.add(`${veh.id}|${pos}`);
  }
  if (APPLY) {
    const allCargoTires = await prisma.tire.findMany({ where: { companyId: COMPANY_ID }, select: { id: true, vehicleId: true, posicion: true } });
    const extras = allCargoTires.filter((t) => {
      if (!t.vehicleId) return true; // inventory not in Excel
      return !excelSlots.has(`${t.vehicleId}|${t.posicion}`);
    });
    console.log(`extras to delete: ${extras.length}`);
    if (extras.length > 0) {
      const ids = extras.map((x) => x.id);
      await prisma.$executeRawUnsafe(`DELETE FROM inspecciones WHERE "tireId" = ANY($1::text[])`, ids);
      await prisma.$executeRawUnsafe(`DELETE FROM tire_costos WHERE "tireId" = ANY($1::text[])`, ids);
      await prisma.$executeRawUnsafe(`DELETE FROM tire_eventos WHERE "tireId" = ANY($1::text[])`, ids);
      await prisma.$executeRawUnsafe(`UPDATE vehicle_tire_history SET "tireId" = NULL WHERE "tireId" = ANY($1::text[])`, ids);
      await prisma.$executeRawUnsafe(`DELETE FROM "Tire" WHERE id = ANY($1::text[])`, ids);
      console.log(`deleted ${extras.length} extras`);
    }
  }

  if (!APPLY) { await prisma.$disconnect(); return; }

  // 4. Refresh tire core + create inspections per Excel row
  let inspCreated = 0;
  let inspIdx = 0;
  for (const row of rows) {
    const p = String(row['Placa '] || row.Placa || '').trim().toLowerCase().replace(/\s+/g, '');
    const pos = parseInt(String(row.Pos || '0'), 10);
    const veh = vehByPlate.get(p);
    if (!veh || !pos) continue;
    const tire = tireByVP.get(`${veh.id}|${pos}`);
    if (!tire) continue;

    const banda = String(row.Banda || '').trim();
    const dial = String(row['# numero de llanta'] || '').trim();
    const fecha = parseDate(row['Fecha Ult Ins']);
    const ext  = num(row['Pro Ext']);
    const cen  = num(row['Pro Cent ']);
    const int_ = num(row['Prf  Int']);
    const min  = num(row.Min);
    const km   = num(row['Km  Actual']);
    const vida = mapVida(String(row.Vida || ''));

    await prisma.tire.update({
      where: { id: tire.id },
      data: {
        ...(dial && dial.toLowerCase() !== 'no aplica' ? { placa: dial } : {}),
        marca: String(row.Marca || 'DESCONOCIDA').trim(),
        diseno: ((banda && banda.toLowerCase() !== 'original') ? banda : String(row['Diseño'] || '').trim()) || 'N/A',
        dimension: String(row['Dimensión '] || row['Dimensión'] || '').trim() || 'N/A',
        eje: mapEje(String(row['Tipo Llanta'] || ''), pos),
        vidaActual: vida,
        totalVidas: vida === VidaValue.nueva ? 0 : 1,
      },
    });

    if (fecha) {
      inspIdx++;
      try {
        await prisma.inspeccion.create({
          data: {
            tireId: tire.id, fecha,
            profundidadInt: int_ || min, profundidadCen: cen || min, profundidadExt: ext || min,
            kmActualVehiculo: km ? Math.round(km) : null,
            kilometrosEstimados: km ? Math.round(km) : null,
            kmEfectivos: km ? Math.round(km) : null,
            vidaAlMomento: vida,
            externalSourceId: `cargolap:excel:${tire.id}:${fecha.toISOString().slice(0,10)}:${inspIdx}`,
            sourceMetadata: { source: 'cargolap_excel_replay', row: { ...row } } as any,
          },
        });
        inspCreated++;
      } catch (e: any) { if (e?.code !== 'P2002') throw e; }
    }
  }
  console.log(`Inspections created: ${inspCreated}`);

  // 5. Vida montaje events for every tire
  await prisma.$executeRawUnsafe(`
    INSERT INTO tire_eventos (id, "tireId", tipo, fecha, notas, metadata, "createdAt")
    SELECT gen_random_uuid()::text, t.id, 'montaje'::"TireEventType",
           COALESCE(t."fechaInstalacion", NOW()), t."vidaActual"::text,
           jsonb_build_object('source','cargolap_replay'), NOW()
      FROM "Tire" t
     WHERE t."companyId" = $1
       AND NOT EXISTS (SELECT 1 FROM tire_eventos e WHERE e."tireId"=t.id AND e.tipo='montaje'::"TireEventType")`, COMPANY_ID);

  // 6. Peer-mean cost for tires without one
  const peer: any[] = await prisma.$queryRaw`
    SELECT UPPER(TRIM(t.dimension)) dim, AVG(tc.valor)::int v
      FROM tire_costos tc JOIN "Tire" t ON t.id = tc."tireId"
     WHERE tc.valor > 0 GROUP BY 1`;
  const peerMap = new Map<string, number>();
  for (const x of peer) peerMap.set(x.dim, x.v);
  const g: any[] = await prisma.$queryRaw`SELECT AVG(valor)::int v FROM tire_costos WHERE valor > 0`;
  const globalAvg = g[0].v;
  const need = await prisma.tire.findMany({ where: { companyId: COMPANY_ID, costos: { none: {} } }, select: { id: true, dimension: true } });
  for (const t of need) {
    const cost = peerMap.get(String(t.dimension || '').toUpperCase().trim()) || globalAvg;
    if (!cost) continue;
    await prisma.tireCosto.create({ data: { tireId: t.id, valor: cost, fecha: new Date(), concepto: 'peer_mean_cost' } });
  }
  console.log(`Costos added: ${need.length}`);

  // 7. Recompute currentCpk + projections + caps
  await prisma.$executeRawUnsafe(`UPDATE "Tire" t SET "currentCpk" = ROUND((cs.total/NULLIF(t."kilometrosRecorridos",0))::numeric,2) FROM (SELECT "tireId", SUM(valor)::numeric total FROM tire_costos GROUP BY "tireId") cs WHERE t.id=cs."tireId" AND t."companyId"=$1 AND t."kilometrosRecorridos">0`, COMPANY_ID);
  await prisma.$executeRawUnsafe(`UPDATE "Tire" SET "currentCpk"=NULL WHERE "companyId"=$1 AND "currentCpk">500`, COMPANY_ID);
  await prisma.$executeRawUnsafe(`
    WITH peer AS (
      SELECT UPPER(TRIM(t.dimension)) dim, ROUND(AVG(t."currentCpk")::numeric,2)::double precision v
        FROM "Tire" t WHERE t."currentCpk" IS NOT NULL AND t."currentCpk" < 500
       GROUP BY 1 HAVING COUNT(*) >= 3
    )
    UPDATE "Tire" t SET "currentCpk"=peer.v FROM peer
     WHERE peer.dim=UPPER(TRIM(t.dimension)) AND t."companyId"=$1 AND t."currentCpk" IS NULL`, COMPANY_ID);
  await prisma.$executeRawUnsafe(`UPDATE "Tire" SET "currentCpk"=(SELECT ROUND(AVG("currentCpk")::numeric,2) FROM "Tire" WHERE "currentCpk" IS NOT NULL AND "currentCpk"<500) WHERE "companyId"=$1 AND "currentCpk" IS NULL`, COMPANY_ID);
  // Sync depth + lastInspeccionDate
  await prisma.$executeRawUnsafe(`
    UPDATE "Tire" tgt SET "currentProfundidad"=sub.avg_d, "lastInspeccionDate"=sub.fecha
      FROM (SELECT DISTINCT ON ("tireId") "tireId", fecha,
                   ("profundidadInt"+"profundidadCen"+"profundidadExt")/3 avg_d
              FROM inspecciones ORDER BY "tireId", fecha DESC) sub
     WHERE tgt.id=sub."tireId" AND tgt."companyId"=$1`, COMPANY_ID);
  // Mirror cpk + cpkProyectado + kmProyectado
  await prisma.$executeRawUnsafe(`UPDATE inspecciones SET cpk=t."currentCpk" FROM "Tire" t WHERE inspecciones."tireId"=t.id AND t."companyId"=$1 AND t."currentCpk" IS NOT NULL`, COMPANY_ID);
  await prisma.$executeRawUnsafe(`UPDATE inspecciones i SET "cpkProyectado" = ROUND((t."currentCpk" * GREATEST((t."profundidadInicial" - t."currentProfundidad")/NULLIF(t."profundidadInicial",0), 0))::numeric, 2)::double precision FROM "Tire" t WHERE i."tireId"=t.id AND t."companyId"=$1 AND t."currentCpk" IS NOT NULL AND t."profundidadInicial">0 AND t."currentProfundidad" IS NOT NULL`, COMPANY_ID);
  await prisma.$executeRawUnsafe(`UPDATE inspecciones i SET "kmProyectado" = LEAST(t."kilometrosRecorridos"::double precision * t."profundidadInicial"/NULLIF(t."profundidadInicial"-t."currentProfundidad",0), 250000) FROM "Tire" t WHERE i."tireId"=t.id AND t."companyId"=$1 AND t."kilometrosRecorridos">0 AND t."profundidadInicial">0 AND t."currentProfundidad" IS NOT NULL AND t."profundidadInicial">t."currentProfundidad"`, COMPANY_ID);
  // For tires without km, peer-mean kmProyectado on their inspections
  await prisma.$executeRawUnsafe(`
    WITH peer AS (
      SELECT UPPER(TRIM(t.dimension)) dim, AVG(i."kmProyectado")::double precision v
        FROM "Tire" t JOIN inspecciones i ON i."tireId"=t.id
       WHERE i."kmProyectado" IS NOT NULL AND i."kmProyectado"<250000
       GROUP BY 1 HAVING COUNT(*) >= 3
    )
    UPDATE inspecciones i SET "kmProyectado"=peer.v
      FROM "Tire" t JOIN peer ON peer.dim=UPPER(TRIM(t.dimension))
     WHERE i."tireId"=t.id AND t."companyId"=$1 AND i."kmProyectado" IS NULL`, COMPANY_ID);
  await prisma.$executeRawUnsafe(`UPDATE inspecciones SET "kmProyectado"=(SELECT AVG("kmProyectado") FROM inspecciones WHERE "kmProyectado" IS NOT NULL AND "kmProyectado"<250000) WHERE "kmProyectado" IS NULL AND "tireId" IN (SELECT id FROM "Tire" WHERE "companyId"=$1)`, COMPANY_ID);

  // Final
  const r: any[] = await prisma.$queryRaw`
    SELECT
      (SELECT COUNT(*)::int FROM "Vehicle" WHERE "companyId"=${COMPANY_ID}) v,
      (SELECT COUNT(*)::int FROM "Tire" WHERE "companyId"=${COMPANY_ID}) t,
      (SELECT COUNT(*)::int FROM "Tire" WHERE "companyId"=${COMPANY_ID} AND "currentCpk" IS NOT NULL) cpk,
      (SELECT COUNT(*)::int FROM "Tire" WHERE "companyId"=${COMPANY_ID} AND "currentProfundidad" IS NOT NULL) depth,
      (SELECT COUNT(DISTINCT "tireId")::int FROM tire_eventos e WHERE e.tipo='montaje' AND e."tireId" IN (SELECT id FROM "Tire" WHERE "companyId"=${COMPANY_ID})) vida,
      (SELECT COUNT(*)::int FROM inspecciones i JOIN "Tire" t ON t.id=i."tireId" WHERE t."companyId"=${COMPANY_ID}) insp`;
  console.log('CARGOLAP final:', JSON.stringify(r[0]));
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
