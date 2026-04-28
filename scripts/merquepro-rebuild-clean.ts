/**
 * Clean Merquellantas rebuild from the 3 source APIs.
 *
 * SAFETY (HARD GUARANTEE): nothing tied to a Remax-distributor client is
 * ever modified or deleted. The script:
 *   - skips any DB row whose current companyId is in the Remax client set
 *   - never reassigns a tire/vehicle into a Remax company
 *   - never deletes orphan rows (companyId=null) — those may belong to a
 *     Remax-shared client (Adispetrol etc.)
 *
 * Sources:
 *  1. /api/report/currentstatetires?ClientType=2&Page=N — iterate all pages,
 *     latest occurrence per tireId wins (higher page = newer).
 *  2. /api/report/currentstatevehicles?Page=N — state="En Operación" links
 *     to the company; other states stay as orphans (companyId=null).
 *  3. /api/report/inspection?Page=N — every row = one inspection event.
 *
 * Rules:
 *  - tire externalSourceId = `merquepro:tire:<tireId>`
 *  - tire.placa = dialNumber
 *  - plate=null → tire.vehicleId=null (inventory)
 *  - assemblyDate older than 3 years from today → tire.companyId=null (orphan)
 *  - state=Desecho → vidaActual=fin (no vehicle)
 *  - DB tire whose tireId is NOT in any current page → vidaActual=fin
 *  - eje from `application` (DIRECCIONAL/TRACCION/ARRASTRE/else)
 *  - vehicleType → configuration via lookup table
 *  - SKU mapped to TireMasterCatalog (skuRef stored in sourceMetadata)
 *
 *   MERQUELLANTAS_TOKEN=... npx ts-node scripts/merquepro-rebuild-clean.ts --apply
 */
import { PrismaClient, EjeType, VidaValue, TireEventType } from '@prisma/client';
import * as fs from 'node:fs';
import * as https from 'node:https';
import { URL as NodeURL } from 'node:url';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const TOKEN = process.env.MERQUELLANTAS_TOKEN?.trim() || 'b495f34d-6a2a-470b-a52e-b7b15e512564';
const OUT_DIR = '/tmp/merquepro3';
const SHARED_BASE  = 'https://shared-mqplatform-prod.azurewebsites.net';
const REPORTS_BASE = 'https://reports-mqplatform-prod.azurewebsites.net';
const MERQUELLANTAS_DISTRIBUTOR_ID = '1cc199e8-354e-4e51-9d62-666c8b68662c';
const REMAX_DISTRIBUTOR_ID         = '8be67ba6-2345-428a-846c-1248d6bbc15a';
const ORPHAN_DATE_CUTOFF = new Date(Date.now() - 3 * 365 * 86400_000);

// =============================================================================
// vehicleType → axle configuration. Conservative defaults.
// =============================================================================
const VEHICLE_TYPE_CONFIG: Record<string, string> = {
  CABEZOTE: '2-4', TRACTOCAMION: '2-4-4', MULA: '2-4-4-4-4', 'MINI MULA': '2-4-4-4',
  CAMION: '2-4', FURGON: '2-2', VOLQUETA: '2-4', VOLCO: '2-4',
  BUS: '2-2', BUSETA: '2-2', MICROBUS: '2-2',
  CARROTANQUE: '2-4-4', REMOLQUE: '2-2-2', SEMIREMOLQUE: '2-4-4',
  PLANCHON: '2-4', TANQUE: '2-4-4', ESTACAS: '2-4',
};
const configFromVehicleType = (vt: string | null | undefined): string | null => {
  if (!vt) return null;
  return VEHICLE_TYPE_CONFIG[vt.trim().toUpperCase().replace(/\s+/g, ' ')] ?? null;
};

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
const parseDate = (v: any): Date | null => {
  if (!v) return null;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
};
const mapEje = (app: string | null): EjeType => {
  const a = (app || '').trim().toUpperCase();
  if (a.startsWith('DIREC')) return EjeType.direccion;
  if (a.startsWith('TRAC'))  return EjeType.traccion;
  if (a.startsWith('ARR') || a.startsWith('REM')) return EjeType.remolque;
  return EjeType.libre;
};
const mapVida = (state: string | null, retreadCount = 0): VidaValue => {
  const s = (state || '').toLowerCase();
  if (s.startsWith('desecho') || s === 'fin') return VidaValue.fin;
  if (s.startsWith('reencauche')) {
    if (retreadCount >= 3) return VidaValue.reencauche3;
    if (retreadCount === 2) return VidaValue.reencauche2;
    return VidaValue.reencauche1;
  }
  return VidaValue.nueva;
};
const norm = (s: string): string => (s || '').trim().toUpperCase().replace(/\s+/g, ' ');

// Retry helper for transient RDS connection drops (P1001 etc.)
const TRANSIENT = new Set(['P1001', 'P1002', 'P1008', 'P1017']);
async function retry<T>(fn: () => Promise<T>, label = 'db'): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e: any) {
      const code = e?.code;
      const msg = e?.message ?? '';
      const isTransient = TRANSIENT.has(code) || /ECONNRESET|ETIMEDOUT|EPIPE|server closed/.test(msg);
      if (!isTransient || i >= 5) throw e;
      const wait = [200, 500, 1500, 4000, 10000][i];
      console.warn(`  [retry] ${label} ${code ?? 'transient'} — waiting ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

const authFetch = (url: string): Promise<any> => new Promise((resolve, reject) => {
  const u = new NodeURL(url);
  https.request({ host: u.host, path: u.pathname + u.search, headers: { Authorization: TOKEN } }, (res) => {
    const c: Buffer[] = [];
    res.on('data', (b) => c.push(b));
    res.on('end', () => {
      const body = Buffer.concat(c).toString();
      if ((res.statusCode ?? 0) >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
      try { resolve(JSON.parse(body)); } catch { resolve(null); }
    });
  }).on('error', reject).end();
});

// Some endpoints (currentstatevehicles) ignore Page and return the same
// payload every call; others paginate. Dedup by row id and stop when no
// new rows appear, OR when the page returns < page-size rows (last page).
const fetchAllPages = async (baseUrl: string, withClientType: boolean): Promise<any[]> => {
  const all: any[] = [];
  const seenIds = new Set<string | number>();
  for (let page = 1; page < 50; page++) {
    const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}Page=${page}${withClientType ? '&ClientType=2' : ''}`;
    let data: any;
    for (let r = 0; r < 3; r++) {
      try { data = await authFetch(url); break; }
      catch (e) { if (r === 2) throw e; await new Promise((r) => setTimeout(r, 500)); }
    }
    if (!Array.isArray(data) || data.length === 0) break;
    let newCount = 0;
    for (const row of data) {
      const id = row?.id ?? `${row?.tireId}-${row?.consecutiveInspection}` ?? JSON.stringify(row).slice(0, 80);
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      all.push(row);
      newCount++;
    }
    process.stdout.write(`  page ${page}: ${data.length} rows (${newCount} new, total ${all.length})\n`);
    if (newCount === 0) break;        // server isn't paginating; we have everything
    if (data.length < 1000) break;    // partial page = last page
  }
  return all;
};

async function main() {
  console.log(APPLY ? '▶ APPLY' : '◇ DRY-RUN');

  // ── SAFETY: compute Remax client set (never touch) ───────────────────────
  const remaxLinks = await prisma.distributorAccess.findMany({ where: { distributorId: REMAX_DISTRIBUTOR_ID }, select: { companyId: true } });
  const remaxClientIds = new Set(remaxLinks.map((l) => l.companyId));
  console.log(`Remax-distributor clients (UNTOUCHABLE): ${remaxClientIds.size}`);

  // Merquellantas-distributor clients
  const merqueLinks = await prisma.distributorAccess.findMany({ where: { distributorId: MERQUELLANTAS_DISTRIBUTOR_ID }, select: { companyId: true } });
  const merqueClientIds = new Set(merqueLinks.map((l) => l.companyId));
  // Safe = Merquellantas AND NOT Remax
  const safeClientIds = new Set([...merqueClientIds].filter((id) => !remaxClientIds.has(id)));
  console.log(`Safe Merquellantas-only clients: ${safeClientIds.size}`);

  // Map company-name → safeCompanyId (only safe clients)
  const safeCompanies = await prisma.company.findMany({ where: { id: { in: [...safeClientIds] } }, select: { id: true, name: true } });
  const nameToSafeId = new Map<string, string>();
  for (const c of safeCompanies) nameToSafeId.set(norm(c.name), c.id);

  // ── FETCH ────────────────────────────────────────────────────────────────
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const fetchOrLoad = async (file: string, baseUrl: string, withClientType: boolean): Promise<any[]> => {
    const path = `${OUT_DIR}/${file}`;
    if (fs.existsSync(path)) {
      const data = JSON.parse(fs.readFileSync(path, 'utf-8'));
      if (Array.isArray(data) && data.length > 0) {
        console.log(`  reusing cached ${file}: ${data.length} rows`);
        return data;
      }
    }
    const all = await fetchAllPages(baseUrl, withClientType);
    fs.writeFileSync(path, JSON.stringify(all));
    return all;
  };
  console.log('\nFETCH /currentstatetires?ClientType=2');
  const tiresRaw = await fetchOrLoad('currentstatetires.json', `${REPORTS_BASE}/api/report/currentstatetires`, true);
  console.log(`  ${tiresRaw.length} rows`);

  console.log('\nFETCH /currentstatevehicles');
  const vehsRaw = await fetchOrLoad('currentstatevehicles.json', `${SHARED_BASE}/api/report/currentstatevehicles`, false);
  console.log(`  ${vehsRaw.length} rows`);

  console.log('\nFETCH /inspection');
  const inspsRaw = await fetchOrLoad('inspection.json', `${REPORTS_BASE}/api/report/inspection`, false);
  console.log(`  ${inspsRaw.length} rows`);

  // ── DEDUP: latest tire per tireId (later page = newer) ───────────────────
  const tireByTireId = new Map<number, any>();
  for (const r of tiresRaw) {
    if (typeof r?.tireId === 'number') tireByTireId.set(r.tireId, r);
  }
  console.log(`\nUnique tireIds: ${tireByTireId.size}`);

  const vehicleSnap = new Map<number, any>();
  for (const v of vehsRaw) {
    if (typeof v?.id === 'number') vehicleSnap.set(v.id, v);
  }

  if (!APPLY) {
    console.log('Dry-run done. Pass --apply to write.');
    await prisma.$disconnect();
    return;
  }

  // ── TireMasterCatalog SKU map ────────────────────────────────────────────
  const catalog = await prisma.tireMasterCatalog.findMany({ select: { skuRef: true, marca: true, modelo: true, dimension: true } });
  const catKey = (m: string, d: string, dim: string) => `${norm(m)}|${norm(d)}|${norm(dim)}`;
  const catByKey = new Map<string, string>();
  for (const c of catalog) catByKey.set(catKey(c.marca, c.modelo, c.dimension), c.skuRef);
  console.log(`Catalog entries: ${catalog.length}`);

  // ── SAFE-UPSERT helper: skip writes that would touch a Remax client ─────
  const isRemaxOwned = (companyId: string | null | undefined): boolean => !!companyId && remaxClientIds.has(companyId);

  // ── UPSERT VEHICLES ──────────────────────────────────────────────────────
  // For each currentstatevehicles row: upsert by externalSourceId.
  // SKIP if existing record's companyId is a Remax client.
  let vehUp = 0, vehSkippedRemax = 0;
  console.log('\nUPSERT vehicles…');
  for (const v of vehsRaw) {
    const cleanedPlate = cleanPlate(v?.plate);
    if (!cleanedPlate) continue;
    const ext = `merquepro:vehicle:${v.id}`;
    const isOrphan = String(v?.state ?? '').trim() !== 'En Operación';
    const clientName = String(v?.client ?? '').trim();
    const safeId = nameToSafeId.get(norm(clientName)) ?? null;
    const targetCompanyId = (isOrphan || !safeId) ? null : safeId;

    // Skip if: (a) plate already owned by a Remax company, or
    // (b) existing merquepro:vehicle row is owned by a Remax company.
    const owners: any[] = await prisma.$queryRaw`
      SELECT v.id, v."companyId" FROM "Vehicle" v
       WHERE v."externalSourceId" = ${ext}
          OR (LOWER(REPLACE(v.placa,' ','')) = ${cleanedPlate.toLowerCase()} AND v."companyId" IS NOT NULL)`;
    const blockedByRemax = owners.some((o) => isRemaxOwned(o.companyId));
    if (blockedByRemax) { vehSkippedRemax++; continue; }

    const config = configFromVehicleType(v?.vehicleType);
    const data = {
      placa: cleanedPlate.toLowerCase(),
      tipovhc: String(v?.vehicleType ?? '').toLowerCase().trim() || 'otro',
      configuracion: config,
      kilometrajeActual: Math.min(num(v?.currentMileage), 2_000_000),
      estadoOperacional: isOrphan ? 'fuera_de_operacion' as const : 'activo' as const,
      fueraDeOperacionDesde: isOrphan ? new Date() : null,
      originalClient: clientName,
      sourceMetadata: v as any,
    };
    try {
      await prisma.vehicle.upsert({
        where: { externalSourceId: ext },
        update: { ...data, companyId: targetCompanyId },
        create: { ...data, companyId: targetCompanyId, carga: 'seca', pesoCarga: 0, externalSourceId: ext },
      });
    } catch (e: any) {
      if (e?.code !== 'P2002') throw e;
      // (companyId, placa) collision — another vehicle has this plate already.
      // Find it and update IF it's not Remax-owned. Update its extId to merge.
      const existing = await prisma.vehicle.findFirst({
        where: { placa: cleanedPlate.toLowerCase(), companyId: targetCompanyId },
        select: { id: true, companyId: true },
      });
      if (existing && !isRemaxOwned(existing.companyId)) {
        // Update data only — leave existing extId in place to avoid colliding
        // with another row that already holds our target ext.
        await prisma.vehicle.update({
          where: { id: existing.id },
          data: { ...data, companyId: targetCompanyId },
        });
      } else {
        vehSkippedRemax++;
        continue;
      }
    }
    vehUp++;
    if (vehUp % 1000 === 0) console.log(`  vehicles: ${vehUp}`);
  }
  console.log(`  vehicles upserted: ${vehUp}  skipped (Remax): ${vehSkippedRemax}`);

  // ── Build vehicleId-num → TirePro vehicle id map ────────────────────────
  const allMVehicles = await prisma.vehicle.findMany({ where: { externalSourceId: { startsWith: 'merquepro:vehicle:' } }, select: { id: true, externalSourceId: true, companyId: true, placa: true } });
  const vehMap = new Map<number, { id: string; companyId: string | null; placa: string }>();
  for (const v of allMVehicles) {
    const n = parseInt((v.externalSourceId || '').replace('merquepro:vehicle:', ''), 10);
    if (!isNaN(n)) vehMap.set(n, { id: v.id, companyId: v.companyId, placa: v.placa });
  }

  // ── UPSERT TIRES ─────────────────────────────────────────────────────────
  let tireUp = 0, tireSkippedRemax = 0;
  console.log('\nUPSERT tires…');
  for (const r of tireByTireId.values()) {
    const ext = `merquepro:tire:${r.tireId}`;
    const clientName = String(r?.client ?? '').trim();
    const safeId = nameToSafeId.get(norm(clientName)) ?? null;

    // Skip rows whose client maps to a non-safe (Remax-shared) company.
    if (!safeId) { tireSkippedRemax++; continue; }

    // Don't overwrite an existing tire that's currently owned by a Remax client
    const existing: any[] = await prisma.$queryRaw`SELECT id, "companyId" FROM "Tire" WHERE "externalSourceId" = ${ext} LIMIT 1`;
    if (existing[0] && isRemaxOwned(existing[0].companyId)) { tireSkippedRemax++; continue; }

    const dial = String(r?.dialNumber ?? r?.tireId ?? '').trim();
    if (!dial) continue;
    const cleanedPlate = cleanPlate(r?.plate);
    const assembly = parseDate(r?.assemblyDate);
    const tooOld = assembly && assembly < ORPHAN_DATE_CUTOFF;
    const noPlate = !cleanedPlate;
    const tireCompanyId = tooOld ? null : safeId;

    const state = String(r?.state ?? '');
    const isDesecho = state.toLowerCase().startsWith('desecho');
    const isRetread = state === 'Reencauche';

    let vehicleId: string | null = null;
    if (!isDesecho && !noPlate && !tooOld) {
      if (typeof r?.vehicleId === 'number') {
        const v = vehMap.get(r.vehicleId);
        if (v && !isRemaxOwned(v.companyId)) vehicleId = v.id;
      }
      if (!vehicleId) {
        const v = await prisma.vehicle.findFirst({
          where: { companyId: safeId, placa: cleanedPlate.toLowerCase() },
          select: { id: true, companyId: true },
        });
        if (v && !isRemaxOwned(v.companyId)) vehicleId = v.id;
      }
    }

    const marca = norm(r?.brand ?? '') || 'DESCONOCIDA';
    const designRaw = String(r?.design ?? '').trim();
    const tireBand = String(r?.tireBand ?? '').trim();
    const diseno = isRetread && tireBand && tireBand !== '-' ? tireBand : (designRaw || 'N/A');
    const dimension = String(r?.dimension ?? '').trim() || 'N/A';
    const profInic = isRetread && num(r?.originalDepthRetread) > 0
      ? num(r.originalDepthRetread) : (num(r?.originalDepth) || 16);
    const skuRef = catByKey.get(catKey(marca, diseno, dimension)) ?? null;
    const depths = [num(r?.currentExternalDepth), num(r?.currentCentralDepth), num(r?.currentInternalDepth)].filter((x) => x > 0);
    const currentProf = depths.length > 0 ? depths.reduce((a, b) => a + b, 0) / depths.length : null;
    const csCreatedDate = parseDate(r?.createdDate);

    const data = {
      vehicleId,
      placa: dial,
      marca,
      diseno,
      dimension,
      eje: mapEje(r?.application),
      posicion: r?.currentPosition && !noPlate ? Number(r.currentPosition) : 0,
      profundidadInicial: profInic,
      vidaActual: mapVida(state),
      totalVidas: isRetread ? 1 : 0,
      kilometrosRecorridos: Math.min(Math.max(0, Math.round(num(r?.mileageTraveled))), 250000),
      currentCpk: num(r?.cpk) > 0 ? num(r.cpk) : null,
      currentProfundidad: currentProf,
      lastInspeccionDate: csCreatedDate ?? assembly,
      fechaInstalacion: assembly,
      originalClient: clientName,
      sourceMetadata: { ...r, _skuRef: skuRef } as any,
    };
    const tire = await retry(() => prisma.tire.upsert({
      where: { externalSourceId: ext },
      update: { ...data, companyId: tireCompanyId },
      create: { ...data, companyId: tireCompanyId, externalSourceId: ext },
    }), 'tire.upsert');

    // Cost: only if commercialCost > 0 and we don't already have one
    if (num(r?.commercialCost) > 0) {
      const exists = await prisma.tireCosto.count({ where: { tireId: tire.id, concepto: { in: ['compra_nueva', 'reencauche'] } } });
      if (exists === 0) {
        await prisma.tireCosto.create({
          data: {
            tireId: tire.id,
            valor: Math.round(num(r.commercialCost)),
            fecha: assembly ?? new Date(),
            concepto: isRetread ? 'reencauche' : 'compra_nueva',
          },
        });
      }
    }
    // Vida event
    const evtExists = await prisma.tireEvento.count({ where: { tireId: tire.id, tipo: TireEventType.montaje } });
    if (evtExists === 0) {
      await prisma.tireEvento.create({
        data: {
          tireId: tire.id, tipo: TireEventType.montaje,
          fecha: assembly ?? new Date(),
          notas: mapVida(state),
          metadata: { source: 'merquepro_rebuild_clean' } as any,
        },
      });
    }
    tireUp++;
    if (tireUp % 5000 === 0) console.log(`  tires: ${tireUp}`);
  }
  console.log(`  tires upserted: ${tireUp}  skipped (Remax): ${tireSkippedRemax}`);

  // ── MARK MISSING TIRES AS FIN ────────────────────────────────────────────
  // Tires in DB with merquepro:tire:* + companyId in safe set but tireId
  // NOT in current pages → mark vidaActual=fin (per user rule).
  const currentIds = [...tireByTireId.keys()].map((n) => `merquepro:tire:${n}`);
  const finUp = await prisma.$executeRawUnsafe(`
    UPDATE "Tire" SET "vidaActual" = 'fin'::"VidaValue"
     WHERE "externalSourceId" LIKE 'merquepro:tire:%'
       AND "externalSourceId" <> ALL($1::text[])
       AND ("companyId" IS NULL OR "companyId" = ANY($2::text[]))
       AND "companyId" <> ALL($3::text[])
       AND "vidaActual" <> 'fin'`, currentIds, [...safeClientIds], [...remaxClientIds]);
  console.log(`Tires marked fin (disappeared from current pages): ${finUp}`);

  // ── INSPECTIONS ──────────────────────────────────────────────────────────
  console.log('\nUPSERT inspections…');
  const tireMap = new Map<number, string>();
  const tiresAfter = await prisma.tire.findMany({ where: { externalSourceId: { startsWith: 'merquepro:tire:' } }, select: { id: true, externalSourceId: true, companyId: true } });
  for (const t of tiresAfter) {
    if (isRemaxOwned(t.companyId)) continue;  // never write inspections for Remax-owned tires
    const n = parseInt((t.externalSourceId || '').replace('merquepro:tire:', ''), 10);
    if (!isNaN(n)) tireMap.set(n, t.id);
  }
  let inspUp = 0;
  for (const i of inspsRaw) {
    if (typeof i?.tireId !== 'number') continue;
    const tireProId = tireMap.get(i.tireId);
    if (!tireProId) continue;
    const fecha = parseDate(i?.date);
    if (!fecha) continue;
    const consec = i?.consecutiveInspection;
    if (consec == null) continue;
    const ext = num(i?.externalDepth), cen = num(i?.centralDepth), int_ = num(i?.internalDepth);
    if (ext === 0 && cen === 0 && int_ === 0) continue;
    const extId = `merquepro:insp:${i.tireId}:${consec}`;
    try {
      await prisma.inspeccion.upsert({
        where: { externalSourceId: extId },
        update: {
          fecha, profundidadInt: int_, profundidadCen: cen, profundidadExt: ext,
          presionPsi: num(i?.airPressure) || null,
          kmActualVehiculo: num(i?.mileage) > 0 ? Math.round(num(i.mileage)) : null,
          inspeccionadoPorNombre: String(i?.owner ?? '').trim() || null,
          vidaAlMomento: mapVida(i?.state),
          sourceMetadata: i as any,
        },
        create: {
          tireId: tireProId, fecha,
          profundidadInt: int_, profundidadCen: cen, profundidadExt: ext,
          presionPsi: num(i?.airPressure) || null,
          kmActualVehiculo: num(i?.mileage) > 0 ? Math.round(num(i.mileage)) : null,
          inspeccionadoPorNombre: String(i?.owner ?? '').trim() || null,
          vidaAlMomento: mapVida(i?.state),
          externalSourceId: extId,
          sourceMetadata: i as any,
        },
      });
      inspUp++;
      if (inspUp % 5000 === 0) console.log(`  insps: ${inspUp}`);
    } catch (e: any) { if (e?.code !== 'P2002') throw e; }
  }
  console.log(`  inspections upserted: ${inspUp}`);

  // ── POST-PASSES (only on merquepro tires not owned by Remax) ────────────
  console.log('\nPOST-PASSES…');
  // Sync currentProfundidad + lastInspeccionDate from latest inspection
  await prisma.$executeRawUnsafe(`
    UPDATE "Tire" tgt SET "currentProfundidad"=sub.avg_d, "lastInspeccionDate"=sub.fecha
      FROM (SELECT DISTINCT ON ("tireId") "tireId", fecha,
                   ("profundidadInt"+"profundidadCen"+"profundidadExt")/3 avg_d
              FROM inspecciones ORDER BY "tireId", fecha DESC) sub
     WHERE tgt.id=sub."tireId"
       AND tgt."externalSourceId" LIKE 'merquepro:tire:%'
       AND ("companyId" IS NULL OR "companyId" <> ALL($1::text[]))`, [...remaxClientIds]);

  // Tire-life km from inspection range
  await prisma.$executeRawUnsafe(`
    UPDATE "Tire" t SET "kilometrosRecorridos" = LEAST((ik.max_km - ik.min_km)::int, 250000)
      FROM (SELECT "tireId", MIN("kmActualVehiculo") min_km, MAX("kmActualVehiculo") max_km
              FROM inspecciones WHERE "kmActualVehiculo" IS NOT NULL AND "kmActualVehiculo" > 0
             GROUP BY "tireId" HAVING COUNT(*) >= 2) ik
     WHERE t.id = ik."tireId"
       AND t."externalSourceId" LIKE 'merquepro:tire:%'
       AND t."kilometrosRecorridos" = 0 AND (ik.max_km - ik.min_km) >= 500
       AND ("companyId" IS NULL OR "companyId" <> ALL($1::text[]))`, [...remaxClientIds]);

  // Inspection km = tire-life km
  await prisma.$executeRawUnsafe(`
    UPDATE inspecciones
       SET "kilometrosEstimados"=NULLIF(src.t_km, 0), "kmEfectivos"=NULLIF(src.t_km, 0)
      FROM (SELECT id, "kilometrosRecorridos" t_km, "companyId"
              FROM "Tire" WHERE "externalSourceId" LIKE 'merquepro:tire:%') src
     WHERE inspecciones."tireId" = src.id
       AND (src."companyId" IS NULL OR src."companyId" <> ALL($1::text[]))`, [...remaxClientIds]);

  // currentCpk = sum(costos) / km, capped at 500
  await prisma.$executeRawUnsafe(`
    UPDATE "Tire" t SET "currentCpk" = ROUND((cs.total / NULLIF(t."kilometrosRecorridos",0))::numeric,2)
      FROM (SELECT "tireId", SUM(valor)::numeric total FROM tire_costos GROUP BY "tireId") cs
     WHERE t.id=cs."tireId" AND t."externalSourceId" LIKE 'merquepro:tire:%'
       AND t."kilometrosRecorridos">0
       AND (t."companyId" IS NULL OR t."companyId" <> ALL($1::text[]))`, [...remaxClientIds]);
  await prisma.$executeRawUnsafe(`UPDATE "Tire" SET "currentCpk"=NULL WHERE "externalSourceId" LIKE 'merquepro:tire:%' AND "currentCpk" > 500`);
  // Peer-mean fallback for null cpk
  await prisma.$executeRawUnsafe(`
    WITH peer AS (
      SELECT UPPER(TRIM(t.dimension)) dim, ROUND(AVG(t."currentCpk")::numeric,2)::double precision v
        FROM "Tire" t WHERE t."currentCpk" IS NOT NULL AND t."currentCpk" < 500
       GROUP BY 1 HAVING COUNT(*) >= 3
    )
    UPDATE "Tire" t SET "currentCpk"=peer.v FROM peer
     WHERE peer.dim=UPPER(TRIM(t.dimension))
       AND t."externalSourceId" LIKE 'merquepro:tire:%' AND t."currentCpk" IS NULL
       AND (t."companyId" IS NULL OR t."companyId" <> ALL($1::text[]))`, [...remaxClientIds]);
  // Mirror to inspections + cpkProyectado + kmProyectado
  await prisma.$executeRawUnsafe(`
    UPDATE inspecciones SET cpk=t."currentCpk" FROM "Tire" t
     WHERE inspecciones."tireId"=t.id AND t."externalSourceId" LIKE 'merquepro:tire:%' AND t."currentCpk" IS NOT NULL
       AND (t."companyId" IS NULL OR t."companyId" <> ALL($1::text[]))`, [...remaxClientIds]);
  await prisma.$executeRawUnsafe(`
    UPDATE inspecciones i SET "cpkProyectado" = ROUND((t."currentCpk" * GREATEST(
      (t."profundidadInicial"-t."currentProfundidad")/NULLIF(t."profundidadInicial",0), 0))::numeric, 2)::double precision
      FROM "Tire" t WHERE i."tireId"=t.id AND t."externalSourceId" LIKE 'merquepro:tire:%'
       AND t."currentCpk" IS NOT NULL AND t."profundidadInicial">0 AND t."currentProfundidad" IS NOT NULL
       AND (t."companyId" IS NULL OR t."companyId" <> ALL($1::text[]))`, [...remaxClientIds]);
  await prisma.$executeRawUnsafe(`
    UPDATE inspecciones i SET "kmProyectado" = LEAST(
      t."kilometrosRecorridos"::double precision * t."profundidadInicial"/NULLIF(t."profundidadInicial"-t."currentProfundidad",0), 250000)
      FROM "Tire" t WHERE i."tireId"=t.id AND t."externalSourceId" LIKE 'merquepro:tire:%'
       AND t."kilometrosRecorridos">0 AND t."profundidadInicial">0 AND t."currentProfundidad" IS NOT NULL
       AND t."profundidadInicial">t."currentProfundidad"
       AND (t."companyId" IS NULL OR t."companyId" <> ALL($1::text[]))`, [...remaxClientIds]);

  // ── SUMMARY ──────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(78));
  console.log('SUMMARY');
  console.log('─'.repeat(78));
  console.log(`Source rows fetched:`);
  console.log(`  currentstatetires:    ${tiresRaw.length} (${tireByTireId.size} unique tireIds)`);
  console.log(`  currentstatevehicles: ${vehsRaw.length}`);
  console.log(`  inspection:           ${inspsRaw.length}`);
  console.log(`Vehicles upserted: ${vehUp}  (skipped Remax: ${vehSkippedRemax})`);
  console.log(`Tires upserted:    ${tireUp}  (skipped Remax: ${tireSkippedRemax})`);
  console.log(`Inspections:       ${inspUp}`);
  console.log(`Marked fin:        ${finUp}`);
  console.log('✅ Applied.');
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
