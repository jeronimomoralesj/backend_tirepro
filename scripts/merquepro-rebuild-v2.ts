/**
 * Merquellantas rebuild — wipe-then-bulk-insert.
 * SAFETY: deletes only rows whose companyId IS NOT in the Remax set.
 * Orphan rows (companyId=null) and Remax-owned rows are preserved.
 */
import { PrismaClient, EjeType, VidaValue } from '@prisma/client';
import * as fs from 'node:fs';
import * as https from 'node:https';
import { URL as NodeURL } from 'node:url';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const TOKEN = process.env.MERQUELLANTAS_TOKEN?.trim() || 'b495f34d-6a2a-470b-a52e-b7b15e512564';
const OUT_DIR = '/tmp/merquepro3';
const SHARED_BASE = 'https://shared-mqplatform-prod.azurewebsites.net';
const REPORTS_BASE = 'https://reports-mqplatform-prod.azurewebsites.net';
const MERQUE_DIST = '1cc199e8-354e-4e51-9d62-666c8b68662c';
const REMAX_DIST  = '8be67ba6-2345-428a-846c-1248d6bbc15a';
const ORPHAN_CUTOFF = new Date(Date.now() - 3 * 365 * 86400_000);

const VT_CFG: Record<string, string> = {
  CABEZOTE: '2-4', TRACTOCAMION: '2-4-4', MULA: '2-4-4-4-4', 'MINI MULA': '2-4-4-4',
  CAMION: '2-4', FURGON: '2-2', VOLQUETA: '2-4', VOLCO: '2-4',
  BUS: '2-2', BUSETA: '2-2', MICROBUS: '2-2',
  CARROTANQUE: '2-4-4', REMOLQUE: '2-2-2', SEMIREMOLQUE: '2-4-4',
  PLANCHON: '2-4', TANQUE: '2-4-4', ESTACAS: '2-4',
};
const cfgVT = (vt: any): string | null => vt ? VT_CFG[String(vt).trim().toUpperCase().replace(/\s+/g, ' ')] ?? null : null;
const cleanPlate = (raw: any): string => {
  if (!raw || typeof raw !== 'string') return '';
  let p = raw.replace(/\s+/g, '').trim();
  const m = p.match(/^[0-9]{1,4}_(.+)$/);
  if (m) p = m[1];
  return p.toUpperCase();
};
const num = (v: any): number => {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
};
const parseDate = (v: any): Date | null => v ? (isNaN(new Date(String(v)).getTime()) ? null : new Date(String(v))) : null;
const mapEje = (a: any): EjeType => {
  const s = String(a || '').trim().toUpperCase();
  if (s.startsWith('DIREC')) return EjeType.direccion;
  if (s.startsWith('TRAC')) return EjeType.traccion;
  if (s.startsWith('ARR') || s.startsWith('REM')) return EjeType.remolque;
  return EjeType.libre;
};
const mapVida = (s: any): VidaValue => {
  const v = String(s || '').toLowerCase();
  if (v.startsWith('desecho') || v === 'fin') return VidaValue.fin;
  if (v.startsWith('reencauche')) return VidaValue.reencauche1;
  return VidaValue.nueva;
};
const norm = (s: any): string => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');

const authFetch = (url: string): Promise<any> => new Promise((resolve, reject) => {
  const u = new NodeURL(url);
  https.request({ host: u.host, path: u.pathname + u.search, headers: { Authorization: TOKEN } }, (res) => {
    const c: Buffer[] = [];
    res.on('data', (b) => c.push(b));
    res.on('end', () => {
      const body = Buffer.concat(c).toString();
      if ((res.statusCode ?? 0) >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
      try { resolve(JSON.parse(body)); } catch { resolve(null); }
    });
  }).on('error', reject).end();
});

const fetchAllPages = async (baseUrl: string, ct: boolean): Promise<any[]> => {
  const all: any[] = [];
  const seen = new Set<any>();
  for (let page = 1; page < 50; page++) {
    const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}Page=${page}${ct ? '&ClientType=2' : ''}`;
    let data: any;
    for (let r = 0; r < 3; r++) {
      try { data = await authFetch(url); break; }
      catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    if (!Array.isArray(data) || data.length === 0) break;
    let n = 0;
    for (const row of data) {
      const id = row?.id ?? `${row?.tireId}-${row?.consecutiveInspection ?? ''}`;
      if (seen.has(id)) continue;
      seen.add(id);
      all.push(row);
      n++;
    }
    console.log(`  page ${page}: ${data.length} (${n} new, total ${all.length})`);
    if (n === 0 || data.length < 1000) break;
  }
  return all;
};

const fetchOrLoad = async (file: string, baseUrl: string, ct: boolean): Promise<any[]> => {
  const path = `${OUT_DIR}/${file}`;
  if (fs.existsSync(path)) {
    const data = JSON.parse(fs.readFileSync(path, 'utf-8'));
    if (Array.isArray(data) && data.length > 0) {
      console.log(`  cached ${file}: ${data.length} rows`);
      return data;
    }
  }
  const all = await fetchAllPages(baseUrl, ct);
  fs.writeFileSync(path, JSON.stringify(all));
  return all;
};

async function retry<T>(fn: () => Promise<T>, label = 'db'): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e: any) {
      const code = e?.code, name = e?.name ?? '', msg = e?.message ?? '';
      const transient = ['P1001','P1002','P1008','P1017'].includes(code)
        || /ECONNRESET|ETIMEDOUT|EPIPE|server closed|reach database server/.test(msg)
        || name === 'PrismaClientInitializationError';
      if (!transient || i >= 8) throw e;
      const wait = [500, 1000, 2000, 5000, 10000, 15000, 20000, 30000][i];
      console.warn(`  [retry] ${label} ${code ?? name} +${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

async function main() {
  console.log(APPLY ? '▶ APPLY' : '◇ DRY-RUN');

  const remaxLinks = await retry(() => prisma.distributorAccess.findMany({ where: { distributorId: REMAX_DIST }, select: { companyId: true } }), 'remax.list');
  const remaxIds = new Set(remaxLinks.map((l) => l.companyId));
  const remaxArr = [...remaxIds];
  console.log(`Remax (UNTOUCHABLE): ${remaxIds.size}`);

  const merqueLinks = await retry(() => prisma.distributorAccess.findMany({ where: { distributorId: MERQUE_DIST }, select: { companyId: true } }), 'merque.list');
  const safeIds = new Set([...merqueLinks.map((l) => l.companyId)].filter((id) => !remaxIds.has(id)));
  console.log(`Safe Merquellantas-only: ${safeIds.size}`);

  const safeCos = await retry(() => prisma.company.findMany({ where: { id: { in: [...safeIds] } }, select: { id: true, name: true } }), 'cos');
  const nameToSafe = new Map<string, string>();
  for (const c of safeCos) nameToSafe.set(norm(c.name), c.id);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log('\nFETCH currentstatetires'); const tiresRaw = await fetchOrLoad('currentstatetires.json', `${REPORTS_BASE}/api/report/currentstatetires`, true);
  console.log('\nFETCH currentstatevehicles'); const vehsRaw = await fetchOrLoad('currentstatevehicles.json', `${SHARED_BASE}/api/report/currentstatevehicles`, false);
  console.log('\nFETCH inspection'); const inspsRaw = await fetchOrLoad('inspection.json', `${REPORTS_BASE}/api/report/inspection`, false);

  const tireById = new Map<number, any>();
  for (const r of tiresRaw) {
    if (typeof r?.tireId === 'number') tireById.set(r.tireId, r);
  }
  console.log(`Unique tireIds: ${tireById.size}`);

  if (!APPLY) { await prisma.$disconnect(); return; }

  const catalog = await retry(() => prisma.tireMasterCatalog.findMany({ select: { skuRef: true, marca: true, modelo: true, dimension: true } }), 'cat');
  const catKey = (m: any, d: any, dim: any) => `${norm(m)}|${norm(d)}|${norm(dim)}`;
  const catBy = new Map<string, string>();
  for (const c of catalog) catBy.set(catKey(c.marca, c.modelo, c.dimension), c.skuRef);

  // ── WIPE merquepro:* on safe clients (Remax + orphans preserved) ────────
  console.log('\nWIPE merquepro safe-client data…');
  // Tires + cascading (inspections, costos, eventos)
  await retry(() => prisma.$executeRawUnsafe(`
    DELETE FROM inspecciones WHERE "tireId" IN (
      SELECT id FROM "Tire" WHERE "externalSourceId" LIKE 'merquepro:tire:%'
        AND "companyId" = ANY($1::text[])
    )`, [...safeIds]), 'wipe.insp');
  await retry(() => prisma.$executeRawUnsafe(`
    DELETE FROM tire_costos WHERE "tireId" IN (
      SELECT id FROM "Tire" WHERE "externalSourceId" LIKE 'merquepro:tire:%'
        AND "companyId" = ANY($1::text[])
    )`, [...safeIds]), 'wipe.costos');
  await retry(() => prisma.$executeRawUnsafe(`
    DELETE FROM tire_eventos WHERE "tireId" IN (
      SELECT id FROM "Tire" WHERE "externalSourceId" LIKE 'merquepro:tire:%'
        AND "companyId" = ANY($1::text[])
    )`, [...safeIds]), 'wipe.events');
  await retry(() => prisma.$executeRawUnsafe(`
    UPDATE vehicle_tire_history SET "tireId"=NULL WHERE "tireId" IN (
      SELECT id FROM "Tire" WHERE "externalSourceId" LIKE 'merquepro:tire:%'
        AND "companyId" = ANY($1::text[])
    )`, [...safeIds]), 'wipe.vth');
  const tireDel: number = await retry(() => prisma.$executeRawUnsafe(`
    DELETE FROM "Tire" WHERE "externalSourceId" LIKE 'merquepro:tire:%'
      AND "companyId" = ANY($1::text[])`, [...safeIds]), 'wipe.tires');
  console.log(`  tires deleted: ${tireDel}`);

  // Vehicles: only the merquepro ones owned by safe clients
  // First null out tire references
  await retry(() => prisma.$executeRawUnsafe(`
    UPDATE "Tire" SET "vehicleId"=NULL, "lastVehicleId"=NULL WHERE "vehicleId" IN (
      SELECT id FROM "Vehicle" WHERE "externalSourceId" LIKE 'merquepro:vehicle:%' AND "companyId" = ANY($1::text[])
    ) OR "lastVehicleId" IN (
      SELECT id FROM "Vehicle" WHERE "externalSourceId" LIKE 'merquepro:vehicle:%' AND "companyId" = ANY($1::text[])
    )`, [...safeIds]), 'wipe.tirevref');
  await retry(() => prisma.$executeRawUnsafe(`
    DELETE FROM vehicle_tire_history WHERE "vehicleId" IN (
      SELECT id FROM "Vehicle" WHERE "externalSourceId" LIKE 'merquepro:vehicle:%' AND "companyId" = ANY($1::text[])
    )`, [...safeIds]), 'wipe.vth2');
  const vehDel: number = await retry(() => prisma.$executeRawUnsafe(`
    DELETE FROM "Vehicle" WHERE "externalSourceId" LIKE 'merquepro:vehicle:%'
      AND "companyId" = ANY($1::text[])`, [...safeIds]), 'wipe.vehs');
  console.log(`  vehicles deleted: ${vehDel}`);

  // ── BULK INSERT VEHICLES ─────────────────────────────────────────────────
  console.log('\nBULK insert vehicles…');
  const vehRows: any[] = [];
  for (const v of vehsRaw) {
    const placa = cleanPlate(v?.plate);
    if (!placa) continue;
    const isOrphan = String(v?.state ?? '').trim() !== 'En Operación';
    const safeId = nameToSafe.get(norm(v?.client)) ?? null;
    if (!safeId && !isOrphan) continue;  // unknown client, en op — skip
    const companyId = (isOrphan || !safeId) ? null : safeId;
    if (companyId === null && !safeId) continue;  // skip orphans whose client is unknown — could be Remax
    if (companyId === null && safeId) {
      // Orphan vehicle of a safe client — store as orphan
    }
    vehRows.push({
      ext: `merquepro:vehicle:${v.id}`,
      placa: placa.toLowerCase(),
      tipovhc: String(v?.vehicleType ?? '').toLowerCase().trim() || 'otro',
      configuracion: cfgVT(v?.vehicleType),
      kilometrajeActual: Math.min(num(v?.currentMileage), 2_000_000),
      estadoOperacional: isOrphan ? 'fuera_de_operacion' : 'activo',
      fueraDeOperacionDesde: isOrphan ? new Date() : null,
      originalClient: String(v?.client ?? '').trim(),
      companyId,
      sourceMetadata: v,
    });
  }
  console.log(`  rows ready: ${vehRows.length}`);

  const VBATCH = 200;
  let vehDone = 0;
  for (let i = 0; i < vehRows.length; i += VBATCH) {
    const slice = vehRows.slice(i, i + VBATCH);
    const values: string[] = [];
    const params: any[] = [];
    let p = 1;
    for (const r of slice) {
      values.push(`(gen_random_uuid()::text, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}::"VehicleOperationalState", $${p++}, $${p++}, 'seca', 0, $${p++}::jsonb, NOW())`);
      params.push(r.ext, r.companyId, r.placa, r.tipovhc, r.configuracion, r.kilometrajeActual, r.estadoOperacional, r.fueraDeOperacionDesde, r.originalClient, JSON.stringify(r.sourceMetadata));
    }
    const sql = `
      INSERT INTO "Vehicle" (id, "externalSourceId", "companyId", placa, tipovhc, configuracion, "kilometrajeActual", "estadoOperacional", "fueraDeOperacionDesde", "originalClient", carga, "pesoCarga", "sourceMetadata", "updatedAt")
      VALUES ${values.join(', ')}
      ON CONFLICT ("externalSourceId") DO NOTHING`;
    await retry(() => prisma.$executeRawUnsafe(sql, ...params), `veh.batch`);
    vehDone += slice.length;
    if (vehDone % 2000 === 0 || vehDone === vehRows.length) console.log(`  vehicles: ${vehDone}/${vehRows.length}`);
  }

  // ── Build vehicleId-num → vehicle id ─────────────────────────────────────
  const allMV = await retry(() => prisma.vehicle.findMany({ where: { externalSourceId: { startsWith: 'merquepro:vehicle:' } }, select: { id: true, externalSourceId: true, companyId: true, placa: true } }), 'load.vehs');
  const vehMap = new Map<number, { id: string; companyId: string | null; placa: string }>();
  const plateMap = new Map<string, { id: string; companyId: string | null }>();
  for (const v of allMV) {
    const n = parseInt((v.externalSourceId || '').replace('merquepro:vehicle:', ''), 10);
    if (!isNaN(n)) vehMap.set(n, { id: v.id, companyId: v.companyId, placa: v.placa });
    plateMap.set(v.placa.toLowerCase(), { id: v.id, companyId: v.companyId });
  }

  // ── BULK INSERT TIRES ────────────────────────────────────────────────────
  console.log('\nBULK insert tires…');
  const tireRows: any[] = [];
  for (const r of tireById.values()) {
    const safeId = nameToSafe.get(norm(r?.client)) ?? null;
    if (!safeId) continue;
    const dial = String(r?.dialNumber ?? r?.tireId ?? '').trim();
    if (!dial) continue;
    const placa = cleanPlate(r?.plate);
    const assembly = parseDate(r?.assemblyDate);
    const tooOld = assembly && assembly < ORPHAN_CUTOFF;
    const noPlate = !placa;
    const state = String(r?.state ?? '');
    const isDesecho = state.toLowerCase().startsWith('desecho');
    const isRetread = state === 'Reencauche';
    const tireCompanyId = tooOld ? null : safeId;
    let vehicleId: string | null = null;
    if (!isDesecho && !noPlate && !tooOld) {
      if (typeof r?.vehicleId === 'number') {
        const v = vehMap.get(r.vehicleId);
        if (v && !(v.companyId && remaxIds.has(v.companyId))) vehicleId = v.id;
      }
      if (!vehicleId && placa) {
        const v = plateMap.get(placa.toLowerCase());
        if (v && v.companyId === safeId) vehicleId = v.id;
      }
    }
    const marca = norm(r?.brand) || 'DESCONOCIDA';
    const designRaw = String(r?.design ?? '').trim();
    const tireBand = String(r?.tireBand ?? '').trim();
    const diseno = isRetread && tireBand && tireBand !== '-' ? tireBand : (designRaw || 'N/A');
    const dimension = String(r?.dimension ?? '').trim() || 'N/A';
    const profInic = isRetread && num(r?.originalDepthRetread) > 0 ? num(r.originalDepthRetread) : (num(r?.originalDepth) || 16);
    const skuRef = catBy.get(catKey(marca, diseno, dimension)) ?? null;
    const depths = [num(r?.currentExternalDepth), num(r?.currentCentralDepth), num(r?.currentInternalDepth)].filter((x) => x > 0);
    const currentProf = depths.length > 0 ? depths.reduce((a, b) => a + b, 0) / depths.length : null;
    const csCreated = parseDate(r?.createdDate);
    tireRows.push({
      ext: `merquepro:tire:${r.tireId}`, companyId: tireCompanyId, vehicleId,
      placa: dial, marca, diseno, dimension,
      eje: mapEje(r?.application),
      posicion: r?.currentPosition && !noPlate ? Number(r.currentPosition) : 0,
      profundidadInicial: profInic,
      vidaActual: mapVida(state),
      totalVidas: isRetread ? 1 : 0,
      kilometrosRecorridos: Math.min(Math.max(0, Math.round(num(r?.mileageTraveled))), 250000),
      currentCpk: num(r?.cpk) > 0 ? num(r.cpk) : null,
      currentProfundidad: currentProf,
      lastInspeccionDate: csCreated ?? assembly,
      fechaInstalacion: assembly,
      sourceMetadata: { ...r, _skuRef: skuRef },
      commercialCost: num(r?.commercialCost),
      isRetread,
    });
  }
  console.log(`  rows ready: ${tireRows.length}`);

  const TBATCH = 500;
  let tDone = 0;
  for (let i = 0; i < tireRows.length; i += TBATCH) {
    const slice = tireRows.slice(i, i + TBATCH);
    const values: string[] = [];
    const params: any[] = [];
    let p = 1;
    for (const r of slice) {
      values.push(`(gen_random_uuid()::text, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}::"EjeType", $${p++}, $${p++}, $${p++}::"VidaValue", $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}::jsonb, NOW())`);
      params.push(r.ext, r.companyId, r.vehicleId, r.placa, r.marca, r.diseno, r.dimension, r.eje, r.posicion, r.profundidadInicial, r.vidaActual, r.totalVidas, r.kilometrosRecorridos, r.currentCpk, r.currentProfundidad, r.fechaInstalacion, JSON.stringify(r.sourceMetadata));
    }
    const sql = `
      INSERT INTO "Tire" (id, "externalSourceId", "companyId", "vehicleId", placa, marca, diseno, dimension, eje, posicion, "profundidadInicial", "vidaActual", "totalVidas", "kilometrosRecorridos", "currentCpk", "currentProfundidad", "fechaInstalacion", "sourceMetadata", "updatedAt")
      VALUES ${values.join(', ')}
      ON CONFLICT ("externalSourceId") DO NOTHING`;
    await retry(() => prisma.$executeRawUnsafe(sql, ...params), 'tires');
    tDone += slice.length;
    if (tDone % 5000 === 0 || tDone === tireRows.length) console.log(`  tires: ${tDone}/${tireRows.length}`);
  }

  // Tire ext → id map (only safe + orphan)
  const allTires = await retry(() => prisma.tire.findMany({ where: { externalSourceId: { startsWith: 'merquepro:tire:' } }, select: { id: true, externalSourceId: true, companyId: true } }), 'load.tires');
  const tIdsByExt = new Map<string, string>();
  for (const t of allTires) {
    if (t.companyId && remaxIds.has(t.companyId)) continue;
    if (t.externalSourceId) tIdsByExt.set(t.externalSourceId, t.id);
  }

  // ── BULK INSPECTIONS ─────────────────────────────────────────────────────
  console.log('\nBULK insert inspections…');
  const inspRows: any[] = [];
  for (const i of inspsRaw) {
    if (typeof i?.tireId !== 'number') continue;
    const tid = tIdsByExt.get(`merquepro:tire:${i.tireId}`);
    if (!tid) continue;
    const fecha = parseDate(i?.date);
    if (!fecha) continue;
    const consec = i?.consecutiveInspection;
    if (consec == null) continue;
    const ext = num(i?.externalDepth), cen = num(i?.centralDepth), int_ = num(i?.internalDepth);
    if (ext === 0 && cen === 0 && int_ === 0) continue;
    inspRows.push({
      ext: `merquepro:insp:${i.tireId}:${consec}`, tireId: tid, fecha,
      profundidadInt: int_, profundidadCen: cen, profundidadExt: ext,
      presionPsi: num(i?.airPressure) || null,
      kmActualVehiculo: num(i?.mileage) > 0 ? Math.round(num(i.mileage)) : null,
      inspeccionadoPorNombre: String(i?.owner ?? '').trim() || null,
      vidaAlMomento: mapVida(i?.state),
      sourceMetadata: i,
    });
  }
  console.log(`  rows ready: ${inspRows.length}`);

  const IBATCH = 500;
  let iDone = 0;
  for (let i = 0; i < inspRows.length; i += IBATCH) {
    const slice = inspRows.slice(i, i + IBATCH);
    const values: string[] = [];
    const params: any[] = [];
    let p = 1;
    for (const r of slice) {
      values.push(`(gen_random_uuid()::text, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}::"VidaValue", $${p++}::jsonb, NOW())`);
      params.push(r.tireId, r.fecha, r.profundidadInt, r.profundidadCen, r.profundidadExt, r.presionPsi, r.kmActualVehiculo, r.inspeccionadoPorNombre, r.ext, r.vidaAlMomento, JSON.stringify(r.sourceMetadata));
    }
    const sql = `
      INSERT INTO inspecciones (id, "tireId", fecha, "profundidadInt", "profundidadCen", "profundidadExt", "presionPsi", "kmActualVehiculo", "inspeccionadoPorNombre", "externalSourceId", "vidaAlMomento", "sourceMetadata", "createdAt")
      VALUES ${values.join(', ')}
      ON CONFLICT ("externalSourceId") DO NOTHING`;
    await retry(() => prisma.$executeRawUnsafe(sql, ...params), 'insps');
    iDone += slice.length;
    if (iDone % 5000 === 0 || iDone === inspRows.length) console.log(`  insps: ${iDone}/${inspRows.length}`);
  }

  // ── COSTOS — bulk batched ────────────────────────────────────────────────
  console.log('\nBULK costos…');
  const costRows: any[] = [];
  for (const t of tireRows) {
    if (!(t.commercialCost > 0)) continue;
    const tid = tIdsByExt.get(t.ext);
    if (!tid) continue;
    costRows.push({ tireId: tid, valor: Math.round(t.commercialCost), fecha: t.fechaInstalacion ?? new Date(), concepto: t.isRetread ? 'reencauche' : 'compra_nueva' });
  }
  console.log(`  rows ready: ${costRows.length}`);
  const CBATCH = 1000;
  for (let i = 0; i < costRows.length; i += CBATCH) {
    const slice = costRows.slice(i, i + CBATCH);
    const values: string[] = [];
    const params: any[] = [];
    let p = 1;
    for (const r of slice) {
      values.push(`(gen_random_uuid()::text, $${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(r.tireId, r.valor, r.fecha, r.concepto);
    }
    await retry(() => prisma.$executeRawUnsafe(`INSERT INTO tire_costos (id, "tireId", valor, fecha, concepto) VALUES ${values.join(', ')}`, ...params), 'costos');
  }

  // ── VIDA EVENTS ──────────────────────────────────────────────────────────
  await retry(() => prisma.$executeRawUnsafe(`
    INSERT INTO tire_eventos (id, "tireId", tipo, fecha, notas, metadata, "createdAt")
    SELECT gen_random_uuid()::text, t.id, 'montaje'::"TireEventType",
           COALESCE(t."fechaInstalacion", NOW()), t."vidaActual"::text,
           jsonb_build_object('source','merquepro_v2'), NOW()
      FROM "Tire" t WHERE t."externalSourceId" LIKE 'merquepro:tire:%'
        AND ("companyId" IS NULL OR "companyId" <> ALL($1::text[]))
        AND NOT EXISTS (SELECT 1 FROM tire_eventos e WHERE e."tireId"=t.id AND e.tipo='montaje'::"TireEventType")
  `, remaxArr), 'vida');
  console.log('vida events created');

  // ── POST-PASSES ──────────────────────────────────────────────────────────
  console.log('\nPOST-PASSES…');
  await retry(() => prisma.$executeRawUnsafe(`
    UPDATE "Tire" tgt SET "currentProfundidad"=sub.avg_d, "lastInspeccionDate"=sub.fecha
      FROM (SELECT DISTINCT ON ("tireId") "tireId", fecha, ("profundidadInt"+"profundidadCen"+"profundidadExt")/3 avg_d FROM inspecciones ORDER BY "tireId", fecha DESC) sub
     WHERE tgt.id=sub."tireId" AND tgt."externalSourceId" LIKE 'merquepro:tire:%'
       AND ("companyId" IS NULL OR "companyId" <> ALL($1::text[]))`, remaxArr), 'pp.depth');
  await retry(() => prisma.$executeRawUnsafe(`
    UPDATE "Tire" t SET "kilometrosRecorridos" = LEAST((ik.max_km - ik.min_km)::int, 250000)
      FROM (SELECT "tireId", MIN("kmActualVehiculo") min_km, MAX("kmActualVehiculo") max_km FROM inspecciones WHERE "kmActualVehiculo">0 GROUP BY "tireId" HAVING COUNT(*)>=2) ik
     WHERE t.id=ik."tireId" AND t."externalSourceId" LIKE 'merquepro:tire:%'
       AND t."kilometrosRecorridos"=0 AND (ik.max_km - ik.min_km) >= 500
       AND ("companyId" IS NULL OR "companyId" <> ALL($1::text[]))`, remaxArr), 'pp.km');
  await retry(() => prisma.$executeRawUnsafe(`
    UPDATE inspecciones SET "kilometrosEstimados"=NULLIF(src.t_km,0), "kmEfectivos"=NULLIF(src.t_km,0)
      FROM (SELECT id, "kilometrosRecorridos" t_km, "companyId" FROM "Tire" WHERE "externalSourceId" LIKE 'merquepro:tire:%') src
     WHERE inspecciones."tireId"=src.id
       AND (src."companyId" IS NULL OR src."companyId" <> ALL($1::text[]))`, remaxArr), 'pp.inspkm');
  await retry(() => prisma.$executeRawUnsafe(`
    UPDATE "Tire" t SET "currentCpk"=ROUND((cs.total/NULLIF(t."kilometrosRecorridos",0))::numeric,2)
      FROM (SELECT "tireId", SUM(valor)::numeric total FROM tire_costos GROUP BY "tireId") cs
     WHERE t.id=cs."tireId" AND t."externalSourceId" LIKE 'merquepro:tire:%' AND t."kilometrosRecorridos">0
       AND ("companyId" IS NULL OR "companyId" <> ALL($1::text[]))`, remaxArr), 'pp.cpk');
  await retry(() => prisma.$executeRawUnsafe(`UPDATE "Tire" SET "currentCpk"=NULL WHERE "externalSourceId" LIKE 'merquepro:tire:%' AND "currentCpk">500`), 'pp.cap');
  await retry(() => prisma.$executeRawUnsafe(`
    WITH peer AS (SELECT UPPER(TRIM(t.dimension)) dim, ROUND(AVG(t."currentCpk")::numeric,2)::double precision v FROM "Tire" t WHERE t."currentCpk" IS NOT NULL AND t."currentCpk"<500 GROUP BY 1 HAVING COUNT(*)>=3)
    UPDATE "Tire" t SET "currentCpk"=peer.v FROM peer
     WHERE peer.dim=UPPER(TRIM(t.dimension)) AND t."externalSourceId" LIKE 'merquepro:tire:%' AND t."currentCpk" IS NULL
       AND ("companyId" IS NULL OR "companyId" <> ALL($1::text[]))`, remaxArr), 'pp.peer');
  await retry(() => prisma.$executeRawUnsafe(`
    UPDATE inspecciones SET cpk=t."currentCpk" FROM "Tire" t
     WHERE inspecciones."tireId"=t.id AND t."externalSourceId" LIKE 'merquepro:tire:%' AND t."currentCpk" IS NOT NULL
       AND ("companyId" IS NULL OR "companyId" <> ALL($1::text[]))`, remaxArr), 'pp.cpk.mirror');
  await retry(() => prisma.$executeRawUnsafe(`
    UPDATE inspecciones i SET "cpkProyectado" = ROUND((t."currentCpk" * GREATEST((t."profundidadInicial"-t."currentProfundidad")/NULLIF(t."profundidadInicial",0),0))::numeric,2)::double precision
      FROM "Tire" t WHERE i."tireId"=t.id AND t."externalSourceId" LIKE 'merquepro:tire:%'
       AND t."currentCpk" IS NOT NULL AND t."profundidadInicial">0 AND t."currentProfundidad" IS NOT NULL
       AND ("companyId" IS NULL OR "companyId" <> ALL($1::text[]))`, remaxArr), 'pp.cpkproy');
  await retry(() => prisma.$executeRawUnsafe(`
    UPDATE inspecciones i SET "kmProyectado" = LEAST(t."kilometrosRecorridos"::double precision * t."profundidadInicial"/NULLIF(t."profundidadInicial"-t."currentProfundidad",0), 250000)
      FROM "Tire" t WHERE i."tireId"=t.id AND t."externalSourceId" LIKE 'merquepro:tire:%'
       AND t."kilometrosRecorridos">0 AND t."profundidadInicial">0 AND t."currentProfundidad" IS NOT NULL
       AND t."profundidadInicial">t."currentProfundidad"
       AND ("companyId" IS NULL OR "companyId" <> ALL($1::text[]))`, remaxArr), 'pp.kmproy');

  console.log('\n✅ DONE.');
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
