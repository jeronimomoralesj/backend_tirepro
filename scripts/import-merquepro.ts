/**
 * Imports the MERQUEPRO (Merquellantas) dataset into TirePro.
 *
 * Source: JSON dumps in /tmp/merquepro, fetched from
 *   https://(shared|reports)-mqplatform-prod.azurewebsites.net/api/report/*
 *
 * What the script does:
 *   1. Upserts one Company per unique client name (Title-cased)
 *   2. Adds each client to Merquellantas' distributor access list
 *   3. Upserts Vehicles by MERQUEPRO vehicleId
 *   4. Upserts Tires by MERQUEPRO tire UUID, writes the purchase / retread
 *      cost into tire_costos
 *   5. Upserts Inspecciones by MERQUEPRO inspection UUID
 *   6. Refreshes the per-tire analytics cache so CPK / health land right
 *
 * Idempotent: every row carries an externalSourceId so a second run
 * updates in place instead of creating duplicates.
 *
 * Usage:
 *   npx ts-node scripts/import-merquepro.ts [--apply]
 *                                           [--clients=N]     (cap for dry-run)
 *                                           [--only-client="STRING"] (filter)
 *                                           [--skip-inspections]
 *                                           [--skip-refresh]
 */
import { PrismaClient, EjeType, VidaValue, TireEventType } from '@prisma/client';
import * as fs from 'node:fs';
import * as path from 'node:path';

const prisma = new PrismaClient();

// ─────────────────────────────────────────────────────────────────────────────
// Transient-error retry
// AWS NLB kills idle connections in the Prisma pool after ~5 min; the next
// query picks up the dead socket and fails with P1001. A 2-hour bulk import
// hits this at least once. Wrap every DB call below with `retry()`.
// ─────────────────────────────────────────────────────────────────────────────
const TRANSIENT_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017']);
const TRANSIENT_MSG_FRAGS = ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'Connection terminated', 'Connection timed out', 'server closed the connection'];
function isTransient(err: unknown): boolean {
  const anyErr = err as { code?: string; message?: string };
  if (anyErr?.code && TRANSIENT_CODES.has(anyErr.code)) return true;
  return TRANSIENT_MSG_FRAGS.some((f) => (anyErr?.message ?? '').includes(f));
}
async function retry<T>(fn: () => Promise<T>, label = 'db'): Promise<T> {
  const backoffs = [200, 500, 1500, 4000, 10000];
  for (let i = 0; i <= backoffs.length; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransient(err) || i === backoffs.length) throw err;
      const wait = backoffs[i];
      const code = (err as any)?.code ?? (err as any)?.message?.slice(0, 60);
      console.warn(`  [retry] ${label} attempt ${i + 1} failed (${code}); waiting ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error('unreachable');
}
const APPLY          = process.argv.includes('--apply');
const SKIP_INSPS     = process.argv.includes('--skip-inspections');
const SKIP_REFRESH   = process.argv.includes('--skip-refresh');
const CLIENTS_ARG    = process.argv.find((a) => a.startsWith('--clients='));
const ONLY_CLIENT    = process.argv.find((a) => a.startsWith('--only-client='))?.slice('--only-client='.length);
const CLIENTS_LIMIT  = CLIENTS_ARG ? Number(CLIENTS_ARG.split('=')[1]) : undefined;

const DATA_DIR = '/tmp/merquepro';
const MERQUELLANTAS_COMPANY_ID = '1cc199e8-354e-4e51-9d62-666c8b68662c';

const EXT_VEHICLE = (id: number | string) => `merquepro:vehicle:${id}`;
const EXT_TIRE    = (id: string)           => `merquepro:tire:${id}`;
const EXT_INSP    = (id: string)           => `merquepro:insp:${id}`;

// =============================================================================
// Pretty-printing
// =============================================================================

const LEGAL_SUFFIXES = new Set([
  'SAS','S.A.S','S.A.S.','SA','S.A','S.A.','LTDA','LTD','LTDA.','SL',
  'CIA','CÍA','CI','ESP','EU','E.S.P','E.S.P.','E.U','E.U.','CV','SCA',
  'SP','S.P.','S.P','SCS','SCA','LLC','INC','CORP',
]);
const SHORT_WORDS = new Set([
  'de','del','la','las','el','los','y','e','o','u','al','por','con','para','en','a',
  'da','das','do','dos','di','du','des','le','les','un','una','unos','unas',
]);

function prettyCompanyName(raw: string): string {
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (!cleaned) return cleaned;
  const words = cleaned.split(' ');
  return words.map((word, i) => {
    const upper = word.toUpperCase().replace(/[.,]/g, '');
    if (LEGAL_SUFFIXES.has(upper) || LEGAL_SUFFIXES.has(word.toUpperCase())) {
      return word.toUpperCase();
    }
    const lower = word.toLowerCase();
    if (i > 0 && SHORT_WORDS.has(lower)) return lower;
    // Handle parenthesised tokens (Urbano), etc.
    if (word.startsWith('(') && word.length > 1) {
      return '(' + capFirst(word.slice(1));
    }
    return capFirst(word);
  }).join(' ');
}
function capFirst(w: string): string {
  if (!w) return w;
  return w.charAt(0).toLocaleUpperCase('es-CO') + w.slice(1).toLocaleLowerCase('es-CO');
}

// =============================================================================
// Mapping helpers
// =============================================================================

function cleanPlate(raw: unknown): string {
  if (!raw || typeof raw !== 'string') return '';
  let p = raw.replace(/\s+/g, '').trim();
  // Strip route prefix like "108_" from "108_TLP696"
  const m = p.match(/^[0-9]{1,4}_(.+)$/);
  if (m) p = m[1];
  return p.toUpperCase();
}

function mapVidaActual(state: string | null | undefined, retreadCount = 1): VidaValue {
  const s = (state ?? '').toLowerCase();
  if (s.startsWith('desecho') || s === 'fin')      return VidaValue.fin;
  if (s.startsWith('reencauche')) {
    if (retreadCount >= 3) return VidaValue.reencauche3;
    if (retreadCount === 2) return VidaValue.reencauche2;
    return VidaValue.reencauche1;
  }
  return VidaValue.nueva;
}

// Sanity caps — upstream data occasionally has runaway odometer values
// (e.g. stuck sensor reporting 5M km). These caps per tire-life are generous
// enough to fit real-world heavy-truck usage.
const MAX_KM_PER_LIFE: Record<VidaValue, number> = {
  [VidaValue.nueva]:        250_000,
  [VidaValue.reencauche1]:  200_000,
  [VidaValue.reencauche2]:  180_000,
  [VidaValue.reencauche3]:  160_000,
  [VidaValue.fin]:          250_000,
};
function capKm(km: number, vida: VidaValue): number {
  const max = MAX_KM_PER_LIFE[vida] ?? 250_000;
  if (km < 0) return 0;
  if (km > max) return max;
  return km;
}

// Vehicle odometer — total lifetime km across all tires. Larger than a single
// tire life; also must fit in INT4 (Postgres 32-bit) so cap at 2,000,000.
const MAX_VEHICLE_KM = 2_000_000;
function capVehicleKm(km: number): number {
  if (!Number.isFinite(km) || km < 0) return 0;
  if (km > MAX_VEHICLE_KM) return MAX_VEHICLE_KM;
  return Math.round(km);
}

function mapEje(pos: number | null | undefined): EjeType {
  // MERQUEPRO stores numeric position only. Without richer metadata we
  // default to `libre` and let the ingest pipeline flag it later.
  if (!pos) return EjeType.libre;
  return EjeType.libre;
}

function mapConfiguracionFromType(raw: string | null | undefined): string | null {
  const t = (raw ?? '').toUpperCase();
  if (!t) return null;
  if (t.includes('14') || t.includes('TRACTO') && t.includes('14')) return '2-4-4-4';
  if (t.includes('18')) return '2-4-4-4-4';
  if (t.includes('10')) return '2-4-4';
  if (t.includes('8'))  return '2-2-4';
  if (t.includes('6'))  return '2-4';
  if (t.includes('4'))  return '2-2';
  return null;
}

function normalizeTipoVhc(raw: string | null | undefined): string {
  const t = (raw ?? '').trim();
  return t ? t.toLowerCase() : 'otro';
}

function toNum(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

function parseDate(v: unknown): Date | null {
  if (!v) return null;
  const s = String(v);
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// =============================================================================
// Load source data
// =============================================================================

function loadJsonArray(file: string): any[] {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return [];
  const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
  return Array.isArray(raw) ? raw : [];
}

function loadAll(prefix: string): any[] {
  const files = fs.readdirSync(DATA_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .sort();
  const rows: any[] = [];
  for (const f of files) {
    const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf-8'));
    if (Array.isArray(data)) rows.push(...data);
  }
  return rows;
}

// =============================================================================
// Main
// =============================================================================

// =============================================================================
// ORPHAN CLASSIFICATION
//
// Merquepro's "fuera de operación" label isn't a field — it's derived from
// `/report/vehiclesWithoutTransaction`, which ships a `months` counter (time
// since last recorded transaction) per vehicle. We treat months >= this
// threshold as fuera de operación. Those vehicles import with companyId=null
// + estadoOperacional=fuera_de_operacion + originalClient=partner, so the
// full record survives for long-horizon analytics but never appears in any
// fleet's dashboard.
// =============================================================================
const ORPHAN_MONTHS_THRESHOLD = 6;

async function main() {
  console.log(APPLY ? '▶ APPLY mode — writing to DB' : '◇ DRY-RUN mode — no writes');

  const vehiclesRaw    = loadJsonArray('vehicles.json');
  const vehiclesWoTx   = loadJsonArray('vehiclesWithoutTransaction.json');
  const tiresRaw       = loadAll('tires_p');
  // currentstatetires is the authoritative "current snapshot" per tire —
  // we merge it into the tire ingest by tireId so the authoritative state
  // (Desecho / Reencauche / etc.), commercial cost per life, and minimal
  // depths come from it instead of the plainer /tires endpoint.
  const currentStateRaw = loadAll('currentstate_p');
  const inspsRaw       = SKIP_INSPS ? [] : loadAll('inspections_p');

  // Build a tireId → currentstate lookup. If the same tireId shows up
  // more than once (shouldn't, but defensive), later pages win so we
  // end up with the freshest snapshot.
  const currentByTireId = new Map<number, any>();
  for (const r of currentStateRaw) {
    if (typeof r?.tireId === 'number') currentByTireId.set(r.tireId, r);
  }

  console.log(`Loaded vehicle txns:            ${vehiclesRaw.length}`);
  console.log(`Loaded vehiclesWithoutTxns:     ${vehiclesWoTx.length}`);
  console.log(`Loaded tires:                   ${tiresRaw.length}`);
  console.log(`Loaded currentstatetires:       ${currentStateRaw.length} (${currentByTireId.size} unique tireIds)`);
  console.log(`Loaded inspections:             ${inspsRaw.length}`);

  // ── Build "inactive vehicle" map from vehiclesWithoutTransaction ─────────
  // Keyed by vehicle.id. Records the idle-time + last activity we need to
  // orphan a vehicle AND enrich its activity signals (kmMensualMerquepro).
  type InactiveInfo = {
    months:   number;
    lastDate: Date | null;
    partner:  string;
    mileage:  number;
    carType:  string;
    operationType: string | null;
    tires:    number;
    raw:      any;
  };
  const inactiveById = new Map<number, InactiveInfo>();
  for (const r of vehiclesWoTx) {
    const vid = r.id;
    if (typeof vid !== 'number') continue;
    inactiveById.set(vid, {
      months:   Number(r.months ?? 0),
      lastDate: parseDate(r.lastDate),
      partner:  String(r.partner ?? '').trim(),
      mileage:  toNum(r.mileage),
      carType:  String(r.carType ?? '').trim(),
      operationType: r.operationType ?? null,
      tires:    Number(r.tires ?? 0),
      raw:      r,
    });
  }
  const isOrphan = (vid: number): boolean => {
    const inf = inactiveById.get(vid);
    return !!inf && inf.months >= ORPHAN_MONTHS_THRESHOLD;
  };
  const orphanCount = [...inactiveById.values()].filter((v) => v.months >= ORPHAN_MONTHS_THRESHOLD).length;
  console.log(`Fuera de operación (>=${ORPHAN_MONTHS_THRESHOLD} months): ${orphanCount} / ${inactiveById.size}\n`);

  // ── Verify Merquellantas exists ──────────────────────────────────────────
  const merque = await prisma.company.findUnique({
    where: { id: MERQUELLANTAS_COMPANY_ID },
  });
  if (!merque) throw new Error('Merquellantas company not found!');
  console.log(`Merquellantas distributor: ${merque.name} (${merque.id})\n`);

  // ── Build unique client list ─────────────────────────────────────────────
  const clientSet = new Set<string>();
  for (const src of [vehiclesRaw, tiresRaw, inspsRaw]) {
    for (const r of src) {
      const c = typeof r.client === 'string' ? r.client.trim() : '';
      if (c) clientSet.add(c);
    }
  }
  let clients = [...clientSet].sort();
  if (ONLY_CLIENT) clients = clients.filter((c) => c.toLowerCase().includes(ONLY_CLIENT.toLowerCase()));
  if (CLIENTS_LIMIT) clients = clients.slice(0, CLIENTS_LIMIT);

  console.log(`Unique clients to process: ${clients.length}`);

  // ── Upsert Company + DistributorAccess per client ────────────────────────
  const clientToCompanyId = new Map<string, string>();

  for (const client of clients) {
    const pretty = prettyCompanyName(client);
    // Prefer finding by exact normalised match; otherwise case-insensitive.
    const existing = await prisma.company.findFirst({
      where: { name: { equals: pretty, mode: 'insensitive' } },
      select: { id: true, name: true },
    });

    let companyId: string;
    if (existing) {
      companyId = existing.id;
    } else if (APPLY) {
      const created = await prisma.company.create({
        data: { name: pretty },
        select: { id: true },
      });
      companyId = created.id;
    } else {
      companyId = 'dryrun-' + Math.random().toString(36).slice(2, 10);
    }

    clientToCompanyId.set(client, companyId);

    if (APPLY && companyId !== MERQUELLANTAS_COMPANY_ID) {
      await prisma.distributorAccess.upsert({
        where: {
          companyId_distributorId: {
            companyId,
            distributorId: MERQUELLANTAS_COMPANY_ID,
          },
        },
        update: {},
        create: {
          companyId,
          distributorId: MERQUELLANTAS_COMPANY_ID,
        },
      });
    }
  }
  console.log(`Clients ${APPLY ? 'upserted' : 'would-upsert'}: ${clients.length}\n`);

  // ── Build vehicleId → (companyId, placa, data) map from the tx dump ──────
  // Multiple rows per vehicle — take the most recent by `date`.
  type VehMeta = {
    vehicleId: number;
    client: string;
    plate: string;
    vehicleType: string;
    actualMileage: number;
    date: Date | null;
    kmPerMonth: number;
    raw: any | null;           // latest raw row from vehicles.json (sourceMetadata)
  };
  const vehicleMetaById = new Map<number, VehMeta>();
  for (const r of vehiclesRaw) {
    const vid = r.id;
    if (typeof vid !== 'number') continue;
    const client = (r.client ?? '').trim();
    if (!clientToCompanyId.has(client)) continue;
    const meta: VehMeta = {
      vehicleId:    vid,
      client,
      plate:        cleanPlate(r.plate),
      vehicleType:  String(r.vehicleType ?? ''),
      actualMileage: toNum(r.actualMileage),
      date:         parseDate(r.date),
      kmPerMonth:   toNum(r.averageMileageTraveledPerMonth),
      raw:          r,
    };
    const prev = vehicleMetaById.get(vid);
    if (!prev || (meta.date && (!prev.date || meta.date > prev.date))) {
      vehicleMetaById.set(vid, meta);
    }
  }

  // Also collect any vehicleId that appears only in the inspections payload
  // but not in the vehicles dump — we still want a Vehicle row for it.
  for (const i of inspsRaw) {
    const vid = i.vehicleId;
    if (typeof vid !== 'number' || vehicleMetaById.has(vid)) continue;
    const client = (i.client ?? '').trim();
    if (!clientToCompanyId.has(client)) continue;
    vehicleMetaById.set(vid, {
      vehicleId: vid,
      client,
      plate: cleanPlate(i.plate),
      vehicleType: String(i.vehicleTypes ?? ''),
      actualMileage: toNum(i.mileage),
      date: parseDate(i.date),
      kmPerMonth: 0,
      raw: null,
    });
  }

  // Fold in every vehiclesWithoutTransaction row too. These vehicles have no
  // transactions yet still own tires + inspections; we'd otherwise silently
  // skip them. Client name comes from `partner` here. No-partner rows stay.
  for (const [vid, inf] of inactiveById.entries()) {
    if (vehicleMetaById.has(vid)) continue;
    const client = inf.partner;
    if (client && !clientToCompanyId.has(client)) {
      // Ensure the orphan partner still gets a Company row so originalClient
      // + DistributorAccess linkage work later. Track for second-pass upsert.
      clientToCompanyId.set(client, '');
    }
    vehicleMetaById.set(vid, {
      vehicleId:    vid,
      client,
      plate:        cleanPlate((inf.raw as any).plate),
      vehicleType:  inf.carType,
      actualMileage: inf.mileage,
      date:         inf.lastDate,
      kmPerMonth:   0,
      raw:          inf.raw,
    });
  }

  // Back-fill any new clients registered from the orphan pool.
  for (const [client, cid] of clientToCompanyId.entries()) {
    if (cid) continue;
    if (!APPLY) { clientToCompanyId.set(client, 'dryrun-' + Math.random().toString(36).slice(2, 10)); continue; }
    const pretty = prettyCompanyName(client);
    const existing = await prisma.company.findFirst({
      where: { name: { equals: pretty, mode: 'insensitive' } },
      select: { id: true },
    });
    const companyId = existing?.id ?? (await prisma.company.create({ data: { name: pretty }, select: { id: true } })).id;
    clientToCompanyId.set(client, companyId);
    if (companyId !== MERQUELLANTAS_COMPANY_ID) {
      await prisma.distributorAccess.upsert({
        where: { companyId_distributorId: { companyId, distributorId: MERQUELLANTAS_COMPANY_ID } },
        update: {},
        create: { companyId, distributorId: MERQUELLANTAS_COMPANY_ID },
      });
    }
  }

  console.log(`Distinct vehicles to upsert: ${vehicleMetaById.size}`);

  // ── Upsert Vehicles (batched) ────────────────────────────────────────────
  const vehicleIdMap = new Map<number, string>(); // MERQUEPRO vehicleId → TirePro id
  let vehicleCreated = 0, vehicleUpdated = 0, vehicleSkipped = 0;

  // Pre-load existing vehicles so the hot path can decide create/update
  // without per-row SELECTs. Two indexes: by externalSourceId, and by
  // (companyId, placaLower) for the adoption fallback.
  const companyIdsForVeh = [...new Set(clientToCompanyId.values())];
  const existingVehBySrc = new Map<string, { id: string; externalSourceId: string | null; configuracion: string | null }>();
  const existingVehByPlate = new Map<string, { id: string; externalSourceId: string | null; configuracion: string | null }>();
  if (APPLY && companyIdsForVeh.length > 0) {
    const rows = await prisma.vehicle.findMany({
      where: { companyId: { in: companyIdsForVeh } },
      select: { id: true, companyId: true, placa: true, externalSourceId: true, configuracion: true },
    });
    for (const v of rows) {
      if (v.externalSourceId) {
        existingVehBySrc.set(v.externalSourceId, {
          id: v.id, externalSourceId: v.externalSourceId, configuracion: v.configuracion,
        });
      }
      existingVehByPlate.set(`${v.companyId}|${v.placa.toLowerCase()}`, {
        id: v.id, externalSourceId: v.externalSourceId, configuracion: v.configuracion,
      });
    }
    console.log(`Pre-loaded vehicles: ${rows.length} (srcIdx=${existingVehBySrc.size}  plateIdx=${existingVehByPlate.size})`);
  }

  const VEH_BATCH = 25;
  // Dedup vehicleIds that resolve to the same (companyId, placa) — MERQUEPRO
  // sometimes assigns two IDs to the same physical vehicle. Keep the one with
  // the highest mileage (newer state), and record the losers so vehicleIdMap
  // still maps them to the winner's TirePro id.
  const winnerByPlateKey = new Map<string, VehMeta>();          // "companyId|placa" → winner meta
  const aliasByVehicleId = new Map<number, number>();            // loser vehicleId → winner vehicleId
  for (const meta of vehicleMetaById.values()) {
    if (!meta.plate) continue;
    const companyId = clientToCompanyId.get(meta.client);
    if (!companyId) continue;
    const key = `${companyId}|${meta.plate.toLowerCase()}`;
    const prev = winnerByPlateKey.get(key);
    if (!prev || meta.actualMileage > prev.actualMileage) {
      if (prev) aliasByVehicleId.set(prev.vehicleId, meta.vehicleId);
      winnerByPlateKey.set(key, meta);
    } else {
      aliasByVehicleId.set(meta.vehicleId, prev.vehicleId);
    }
  }
  const vehMetas = [...winnerByPlateKey.values()];
  console.log(`After (companyId,placa) dedup: ${vehMetas.length} winners  ${aliasByVehicleId.size} aliases`);

  let vehicleOrphaned = 0;

  async function processVehicle(meta: VehMeta) {
    if (!meta.plate) { vehicleSkipped++; return; }
    const clientCompanyId = clientToCompanyId.get(meta.client);
    if (!clientCompanyId) { vehicleSkipped++; return; }

    const ext = EXT_VEHICLE(meta.vehicleId);
    if (!APPLY) {
      vehicleIdMap.set(meta.vehicleId, `dryrun-v-${meta.vehicleId}`);
      return;
    }
    const plateLower    = meta.plate.toLowerCase();
    const configuracion = mapConfiguracionFromType(meta.vehicleType);
    const tipovhc       = normalizeTipoVhc(meta.vehicleType);
    const inactive      = inactiveById.get(meta.vehicleId);
    const orphan        = isOrphan(meta.vehicleId);
    // Orphans don't link to any fleet; every other field is preserved.
    const companyId: string | null = orphan ? null : clientCompanyId;

    // sourceMetadata — lossless blob of every source field we don't promote
    // to a first-class column, per the zero-data-loss contract.
    const sourceMetadata = {
      ...(meta.raw ?? {}),
      inactiveInfo: inactive ? {
        months:   inactive.months,
        lastDate: inactive.lastDate?.toISOString() ?? null,
        partner:  inactive.partner,
        mileage:  inactive.mileage,
        carType:  inactive.carType,
        operationType: inactive.operationType,
        tires:    inactive.tires,
      } : null,
    };

    // Dedup order: ext id → (clientCompanyId, placa) [existing live fleet
    // row] — orphans also match here so we don't re-orphan a vehicle that
    // was already imported.
    let existing = existingVehBySrc.get(ext)
      ?? existingVehByPlate.get(`${clientCompanyId}|${plateLower}`)
      ?? null;

    const baseCommon = {
      kilometrajeActual: capVehicleKm(meta.actualMileage),
      tipovhc,
      kmMensualMerquepro:    meta.kmPerMonth || null,
      originalClient:        meta.client,
      ultimaActividadAt:     meta.date ?? null,
      estadoOperacional:     orphan ? 'fuera_de_operacion' as const : 'activo' as const,
      fueraDeOperacionDesde: orphan ? (inactive?.lastDate ?? new Date()) : null,
      sourceMetadata:        sourceMetadata as any,
    };

    if (existing) {
      const upd = await retry(() => prisma.vehicle.update({
        where: { id: existing.id },
        data: {
          ...baseCommon,
          placa:         plateLower,
          configuracion: configuracion ?? existing.configuracion,
          companyId,
          ...(existing.externalSourceId ? {} : { externalSourceId: ext }),
        },
        select: { id: true },
      }), 'vehicle.update');
      vehicleIdMap.set(meta.vehicleId, upd.id);
      if (orphan) vehicleOrphaned++;
      vehicleUpdated++;
    } else {
      try {
        const created = await retry(() => prisma.vehicle.create({
          data: {
            ...baseCommon,
            placa:             plateLower,
            carga:             'seca',
            pesoCarga:         0,
            configuracion,
            companyId,
            externalSourceId:  ext,
          },
          select: { id: true },
        }), 'vehicle.create');
        vehicleIdMap.set(meta.vehicleId, created.id);
        const rec = { id: created.id, externalSourceId: ext, configuracion };
        existingVehBySrc.set(ext, rec);
        existingVehByPlate.set(`${clientCompanyId}|${plateLower}`, rec);
        if (orphan) vehicleOrphaned++;
        vehicleCreated++;
      } catch (err: any) {
        if (err?.code !== 'P2002') throw err;
        // Raced with another wave-mate or a pre-existing row we missed.
        // Re-fetch and update instead of failing the import.
        const found = await prisma.vehicle.findFirst({
          where: { placa: plateLower, OR: [{ companyId: clientCompanyId }, { companyId: null, externalSourceId: ext }] },
          select: { id: true, externalSourceId: true, configuracion: true },
        });
        if (!found) throw err;
        const upd = await prisma.vehicle.update({
          where: { id: found.id },
          data: {
            ...baseCommon,
            configuracion: configuracion ?? found.configuracion,
            companyId,
            ...(found.externalSourceId ? {} : { externalSourceId: ext }),
          },
          select: { id: true },
        });
        vehicleIdMap.set(meta.vehicleId, upd.id);
        const rec = { id: upd.id, externalSourceId: found.externalSourceId ?? ext, configuracion: configuracion ?? found.configuracion };
        if (rec.externalSourceId) existingVehBySrc.set(rec.externalSourceId, rec);
        existingVehByPlate.set(`${clientCompanyId}|${plateLower}`, rec);
        if (orphan) vehicleOrphaned++;
        vehicleUpdated++;
      }
    }
  }

  console.log(`Upserting ${vehMetas.length} vehicles (batch=${VEH_BATCH})…`);
  const startedV = Date.now();
  for (let i = 0; i < vehMetas.length; i += VEH_BATCH) {
    const slice = vehMetas.slice(i, i + VEH_BATCH);
    await Promise.all(slice.map(processVehicle));
    if ((i + VEH_BATCH) % 1000 === 0 || (i + VEH_BATCH) >= vehMetas.length) {
      const elapsed = Math.round((Date.now() - startedV) / 1000);
      console.log(`  veh ${Math.min(i + VEH_BATCH, vehMetas.length)} / ${vehMetas.length}   +${vehicleCreated}n  ${vehicleUpdated}u  ${vehicleSkipped}sk  (${elapsed}s)`);
    }
  }
  console.log(`Vehicles — created: ${vehicleCreated}  updated: ${vehicleUpdated}  skipped: ${vehicleSkipped}  orphaned: ${vehicleOrphaned}\n`);

  // Set of "clientCompanyId|placaLower" for orphan vehicles. Used to orphan
  // the tires that belong to them in the next section.
  const orphanPlateKeys = new Set<string>();
  for (const meta of vehMetas) {
    if (!isOrphan(meta.vehicleId)) continue;
    const cid = clientToCompanyId.get(meta.client);
    if (!cid || !meta.plate) continue;
    orphanPlateKeys.add(`${cid}|${meta.plate.toLowerCase()}`);
  }

  // ── Upsert Tires ─────────────────────────────────────────────────────────
  // MERQUEPRO stores one row per tire STATE. The same physical tire may
  // appear in multiple rows (nueva → reencauche → desecho). We collapse
  // to one TirePro Tire per (client, dialNumber), keeping the most
  // recent row's state so vidaActual/currentCpk reflect today's reality.
  type TireRow = typeof tiresRaw[number];
  const latestByClientDial = new Map<string, TireRow>();
  for (const r of tiresRaw) {
    const client = (r.client ?? '').trim();
    const dial   = r.dialNumber;
    if (!client || dial == null) continue;
    const key = `${client.toLowerCase()}__${dial}`;
    const prev = latestByClientDial.get(key);
    const prevDate = prev ? new Date(prev.createdDate ?? 0).getTime() : 0;
    const thisDate = new Date(r.createdDate ?? 0).getTime();
    if (!prev || thisDate > prevDate) latestByClientDial.set(key, r);
  }
  const canonicalTires = [...latestByClientDial.values()];
  console.log(`Canonical tires (after (client,dialNumber) dedup): ${canonicalTires.length}`);

  // Count reencauche rows per (client, dial) so we can tag the canonical
  // tire as reencauche1/2/3 based on how many retreads the source recorded.
  const retreadCountByKey = new Map<string, number>();
  for (const r of tiresRaw) {
    const client = (r.client ?? '').trim();
    if (!client || r.dialNumber == null) continue;
    if (!String(r.state ?? '').startsWith('Reencauche')) continue;
    const key = `${client.toLowerCase()}__${r.dialNumber}`;
    retreadCountByKey.set(key, (retreadCountByKey.get(key) ?? 0) + 1);
  }

  // ── Cost estimation fallback ────────────────────────────────────────────
  // MERQUEPRO doesn't ship a commercialCost for every tire. To keep CPK
  // analytics honest we estimate missing costs from peers with the same
  // (dimension, marca, vida) — and fall back to (dimension, vida), then
  // (vida) alone — using the mean of rows that DO carry a price.
  type CostAgg = { sum: number; n: number };
  const costByDimMarcaVida = new Map<string, CostAgg>();
  const costByDimVida      = new Map<string, CostAgg>();
  const costByVida         = new Map<string, CostAgg>();
  const costKey = (dim: string, marca: string, vida: string) =>
    `${dim.toLowerCase()}|${marca.toLowerCase()}|${vida}`;
  const bump = (m: Map<string, CostAgg>, k: string, v: number) => {
    const a = m.get(k);
    if (a) { a.sum += v; a.n += 1; } else m.set(k, { sum: v, n: 1 });
  };

  for (const r of canonicalTires) {
    const price = toNum(r.commercialCost);
    if (price <= 0) continue;
    const dim   = (r.dimension ?? '').trim() || 'N/A';
    const marca = (r.trademark ?? '').trim() || 'DESCONOCIDA';
    const vida  = mapVidaActual(r.state);
    bump(costByDimMarcaVida, costKey(dim, marca, vida), price);
    bump(costByDimVida,      `${dim.toLowerCase()}|${vida}`, price);
    bump(costByVida,         vida, price);
  }
  const avg = (a: CostAgg | undefined) => a && a.n > 0 ? Math.round(a.sum / a.n) : 0;
  function estimateCost(dim: string, marca: string, vida: string): number {
    return (
      avg(costByDimMarcaVida.get(costKey(dim, marca, vida))) ||
      avg(costByDimVida.get(`${dim.toLowerCase()}|${vida}`)) ||
      avg(costByVida.get(vida))
    );
  }
  console.log(
    `Cost estimators: ${costByDimMarcaVida.size} by (dim,marca,vida)  ` +
    `${costByDimVida.size} by (dim,vida)  ${costByVida.size} by (vida)`,
  );

  // Pre-load every vehicle lookup we'll need so the hot path doesn't do a
  // per-tire SELECT. Keys: "companyId|placaLower" → vehicleId.
  const companyIds = [...new Set(clientToCompanyId.values())];
  const allVehicleRows = APPLY && companyIds.length > 0
    ? await prisma.vehicle.findMany({
        where: { companyId: { in: companyIds } },
        select: { id: true, companyId: true, placa: true },
      })
    : [];
  const vehicleByPlate = new Map<string, string>();
  for (const v of allVehicleRows) {
    vehicleByPlate.set(`${v.companyId}|${v.placa.toLowerCase()}`, v.id);
  }

  // Pre-load already-imported tire externalSourceIds so we know which
  // ones exist without a SELECT per row.
  const existingTireBySrc = new Map<string, string>();
  if (APPLY) {
    const rows = await prisma.tire.findMany({
      where: { externalSourceId: { startsWith: 'merquepro:tire:' } },
      select: { id: true, externalSourceId: true },
    });
    for (const r of rows) {
      if (r.externalSourceId) existingTireBySrc.set(r.externalSourceId, r.id);
    }
  }

  const tireIdMap           = new Map<string, string>();  // MERQUEPRO tire.id → TirePro id
  const tireByClientDialId  = new Map<string, string>();  // "client|dial" → TirePro id (for inspection linkage)
  let tireCreated = 0, tireUpdated = 0, tireSkipped = 0;
  let costReal = 0, costDerived = 0, costEstimated = 0, costMissing = 0;
  let kmCapped = 0;

  // Batched concurrency: each tire does 2-3 queries (upsert + findFirst
  // for vida event + optional costo insert), so TIRE_BATCH=8 keeps the pool
  // (default 10) from timing out under the v2 schema's extra writes.
  const TIRE_BATCH = 8;
  let tireOrphaned = 0;

  async function processTire(r: TireRow) {
    const client = (r.client ?? '').trim();
    const clientCompanyId = clientToCompanyId.get(client);
    if (!clientCompanyId) { tireSkipped++; return; }

    // Authoritative snapshot from /currentstatetires — carries the true
    // current state (including Desecho), commercialCost per life, and
    // richer depth data. Fall back to /tires fields when this tire isn't
    // in the snapshot (e.g. newly created or the snapshot pagination
    // missed it).
    const cs = r.tireId != null ? currentByTireId.get(Number(r.tireId)) : undefined;
    const sourceState = (cs?.state ?? r.state) as string | undefined;

    const extTire = EXT_TIRE(r.id);
    const dial    = r.dialNumber ? String(r.dialNumber) : r.id;
    const rcKey   = `${client.toLowerCase()}__${r.dialNumber}`;
    const retreadCount = retreadCountByKey.get(rcKey) ?? 0;
    const vidaActual   = mapVidaActual(sourceState, retreadCount || 1);
    const totalVidas   = vidaActual === VidaValue.fin
      ? Math.max(retreadCount, 1)
      : vidaActual === VidaValue.nueva ? 0 : Math.max(retreadCount, 1);
    const marca       = (cs?.brand ?? r.trademark ?? '').trim() || 'DESCONOCIDA';
    const isRetread   = sourceState === 'Reencauche' || vidaActual !== VidaValue.nueva;
    // tireBand lives on /tires; currentstate uses `tireBand` the same way.
    const bandName    = (cs?.tireBand ?? r.tireBand ?? '').trim();
    const diseno      = isRetread && bandName && bandName !== '-'
      ? bandName
      : (cs?.design ?? r.design ?? '').trim() || 'N/A';
    const dimension   = (cs?.dimension ?? r.dimension ?? '').trim() || 'N/A';
    // originalDepthRetread applies when the tire is currently on a retread
    // life; otherwise originalDepth (the first mount's banda thickness).
    const rawProfInic = isRetread
      ? toNum(cs?.originalDepthRetread ?? r.originalDepthRetread) || toNum(cs?.originalDepth ?? r.originalDepth)
      : toNum(cs?.originalDepth ?? r.originalDepth);
    const profInic    = rawProfInic > 0 ? rawProfInic : 16;
    const rawKm       = Math.max(0, Math.round(toNum(cs?.mileageTraveled ?? r.mileageTraveled)));
    const kmRecorr    = capKm(rawKm, vidaActual);
    if (kmRecorr < rawKm) kmCapped++;
    // Prefer the CPK from currentstatetires (the 3rd API) — that's the
    // authoritative one Merquellantas publishes. Fall back to /tires only
    // when the snapshot doesn't have it. Post-pass (B) recomputes from
    // costs / km when both sides are zero/null.
    const cpk         = toNum(cs?.cpk ?? r.cpk);
    // commercialCost on currentstate is per-life and reliable; /tires
    // often returns 0 for retreads. Prefer currentstate when available.
    const commercial  = toNum(cs?.commercialCost ?? r.commercialCost);
    const installDate = parseDate(r.assemblyDate);

    let vehicleId: string | null = null;
    const cleanedPlate = cleanPlate(r.plate);
    const plateKey = cleanedPlate ? `${clientCompanyId}|${cleanedPlate.toLowerCase()}` : null;
    if (plateKey && vidaActual !== VidaValue.fin) {
      vehicleId = vehicleByPlate.get(plateKey) ?? null;
    }

    // Tire inherits orphan status from its host vehicle. Tire.companyId null
    // means it never surfaces in any fleet dashboard but is still queryable
    // for cross-fleet analytics.
    const hostIsOrphan = !!plateKey && orphanPlateKeys.has(plateKey);
    const companyId: string | null = hostIsOrphan ? null : clientCompanyId;
    if (hostIsOrphan) tireOrphaned++;

    const baseTireData = {
      companyId,
      vehicleId,
      placa:              dial.toString(),
      marca:              marca.trim(),
      diseno:             diseno.trim(),
      dimension:          dimension.trim(),
      eje:                mapEje(r.position),
      posicion:           r.position ?? 0,
      profundidadInicial: profInic,
      vidaActual,
      totalVidas,
      kilometrosRecorridos: kmRecorr,
      currentCpk:         cpk > 0 ? cpk : null,
      fechaInstalacion:   installDate,
      externalSourceId:   extTire,
      originalClient:     client,
      // Lossless: every non-promoted source field stays addressable under
      // sourceMetadata for later analytics / audit.
      sourceMetadata:     r as any,
    };

    if (!APPLY) {
      tireIdMap.set(r.id, `dryrun-t-${r.id}`);
      tireByClientDialId.set(`${client.toLowerCase()}|${r.dialNumber}`, `dryrun-t-${r.id}`);
      return;
    }

    const existingId = existingTireBySrc.get(extTire);
    let tireId: string;
    if (existingId) {
      await retry(() => prisma.tire.update({ where: { id: existingId }, data: baseTireData }), 'tire.update');
      tireId = existingId;
      tireUpdated++;
    } else {
      const created = await retry(() => prisma.tire.create({
        data: baseTireData,
        select: { id: true },
      }), 'tire.create');
      tireId = created.id;
      tireCreated++;
      // Remember the new id so a transient retry doesn't try to re-create it
      // (which would explode on the externalSourceId unique constraint).
      existingTireBySrc.set(extTire, tireId);
    }
    tireIdMap.set(r.id, tireId);
    tireByClientDialId.set(`${client.toLowerCase()}|${r.dialNumber}`, tireId);

    // Mirror vidaActual onto a montaje TireEvento. The UI reads tire.vida
    // from these events (not the Tire row directly), so skipping this step
    // makes every imported tire look like a blank "nueva" in DetallesLlantas.
    // Idempotent: skip when a vida event for this tire already exists.
    const hasVidaEvt = await retry(() => prisma.tireEvento.findFirst({
      where: {
        tireId,
        tipo: TireEventType.montaje,
        notas: { in: [VidaValue.nueva, VidaValue.reencauche1, VidaValue.reencauche2, VidaValue.reencauche3, VidaValue.fin] },
      },
      select: { id: true },
    }), 'tireEvento.findFirst');
    if (!hasVidaEvt) {
      await retry(() => prisma.tireEvento.create({
        data: {
          tireId,
          tipo:  TireEventType.montaje,
          fecha: installDate ?? new Date(),
          notas: vidaActual,
          metadata: { source: 'merquepro_import' } as any,
        },
      }), 'tireEvento.create');
    }

    // Cost entry — createMany with skipDuplicates avoids a pre-select. We
    // tag the migrated cost with a deterministic concepto so re-runs see
    // the same row and skip via the unique (tireId, fecha, concepto)
    // combination isn't enforced so we tolerate a duplicate if the script
    // is re-run after a Tire was re-created.
    let costValue = commercial;
    let costOrigin: 'real' | 'derived' | 'estimated' = 'real';
    // Tier 1: MERQUEPRO's own cpk × km. cpk is pesos/km, km is capped.
    if (costValue <= 0 && cpk > 0 && kmRecorr > 0) {
      costValue = Math.round(cpk * kmRecorr);
      costOrigin = 'derived';
    }
    // Tier 2: peer-mean fallback on (dim, marca, vida) → (dim, vida) → (vida).
    if (costValue <= 0) {
      const est = estimateCost(dimension, marca, vidaActual);
      if (est > 0) { costValue = est; costOrigin = 'estimated'; }
    }
    if (costValue > 0) {
      const baseConcept = vidaActual === VidaValue.nueva ? 'compra_nueva' : 'reencauche';
      const suffix = costOrigin === 'real' ? '' : `_${costOrigin}`;
      const concept = `${baseConcept}${suffix}`;
      const costFecha = installDate ?? new Date();
      if (!existingId) {
        // Only insert on first-time tire creation — prevents duplicates on re-run.
        await retry(() => prisma.tireCosto.create({
          data: { tireId, valor: costValue, fecha: costFecha, concepto: concept },
        }), 'tireCosto.create');
      }
      if (costOrigin === 'real')      costReal++;
      else if (costOrigin === 'derived') costDerived++;
      else                              costEstimated++;
    } else {
      costMissing++;
    }
  }

  // Run tire upserts in waves of TIRE_BATCH in parallel.
  console.log(`Upserting ${canonicalTires.length} tires (batch=${TIRE_BATCH})…`);
  const started = Date.now();
  for (let i = 0; i < canonicalTires.length; i += TIRE_BATCH) {
    const slice = canonicalTires.slice(i, i + TIRE_BATCH);
    await Promise.all(slice.map(processTire));
    if ((i + TIRE_BATCH) % 2500 === 0 || (i + TIRE_BATCH) >= canonicalTires.length) {
      const elapsed = Math.round((Date.now() - started) / 1000);
      console.log(`  tires ${Math.min(i + TIRE_BATCH, canonicalTires.length)} / ${canonicalTires.length}   +${tireCreated}n  ${tireUpdated}u  ${tireSkipped}sk  (${elapsed}s)`);
    }
  }
  console.log(`Tires — created: ${tireCreated}  updated: ${tireUpdated}  skipped: ${tireSkipped}  orphaned: ${tireOrphaned}`);
  console.log(`Costs — real: ${costReal}  derived(cpk×km): ${costDerived}  estimated: ${costEstimated}  still-missing: ${costMissing}`);
  console.log(`Km sanity cap applied to: ${kmCapped} tires\n`);

  // ── Upsert Inspecciones (batched concurrency) ───────────────────────────
  let inspCreated = 0, inspUpdated = 0, inspSkipped = 0;
  const tiresNeedingRefresh = new Set<string>();

  if (!SKIP_INSPS && APPLY) {
    // Pre-load every already-imported inspection's externalSourceId so we
    // can decide create vs update without a per-row SELECT.
    const existingInspRows = await prisma.inspeccion.findMany({
      where: { externalSourceId: { startsWith: 'merquepro:insp:' } },
      select: { id: true, externalSourceId: true },
    });
    const existingInspBySrc = new Map<string, string>();
    for (const row of existingInspRows) {
      if (row.externalSourceId) existingInspBySrc.set(row.externalSourceId, row.id);
    }

    const INSP_BATCH = 8;
    async function processInsp(i: any) {
      const iClient = (i.client ?? '').trim();
      if (!iClient || i.dialNumber == null) { inspSkipped++; return; }
      const tireLocalId = tireByClientDialId.get(`${iClient.toLowerCase()}|${i.dialNumber}`);
      if (!tireLocalId) { inspSkipped++; return; }
      const fecha = parseDate(i.date);
      if (!fecha) { inspSkipped++; return; }

      // MERQUEPRO sometimes emits phantom rows with empty state and null
      // depths. Skip them — they pollute the tire's depth/vida history.
      const d1 = toNum(i.internalDepth), d2 = toNum(i.centralDepth), d3 = toNum(i.externalDepth);
      if (d1 === 0 && d2 === 0 && d3 === 0 && !String(i.state ?? '').trim()) {
        inspSkipped++; return;
      }

      const extInsp = EXT_INSP(i.id);
      const rawMileage = Math.round(toNum(i.mileage));
      const mileage = rawMileage > 0 ? capVehicleKm(rawMileage) : null;
      const inspData = {
        tireId:               tireLocalId,
        fecha,
        profundidadInt:       toNum(i.internalDepth),
        profundidadCen:       toNum(i.centralDepth),
        profundidadExt:       toNum(i.externalDepth),
        presionPsi:           toNum(i.airPressure) || null,
        kilometrosEstimados:  mileage,
        kmActualVehiculo:     mileage,
        kmEfectivos:          mileage,
        inspeccionadoPorNombre: (i.adviser ?? '').trim() || null,
        vidaAlMomento:        mapVidaActual(i.state),
        externalSourceId:     extInsp,
        // Lossless: preserve every source field (alert, operationType,
        // owner, driver, reportState, consecutive*, transactionIds, etc.).
        sourceMetadata:       i as any,
      };
      const existingId = existingInspBySrc.get(extInsp);
      if (existingId) {
        await retry(() => prisma.inspeccion.update({ where: { id: existingId }, data: inspData }), 'inspeccion.update');
        inspUpdated++;
      } else {
        try {
          await retry(() => prisma.inspeccion.create({ data: inspData }), 'inspeccion.create');
          inspCreated++;
          existingInspBySrc.set(extInsp, 'just-created'); // dedupe if retried later
        } catch (err) {
          // Idempotency guard: if two concurrent Promise.all workers raced to
          // create the same externalSourceId, one wins and the other gets
          // P2002. Swallow that specific case instead of killing the run.
          if ((err as any)?.code === 'P2002') { inspSkipped++; }
          else throw err;
        }
      }
      tiresNeedingRefresh.add(tireLocalId);
    }

    console.log(`Upserting ${inspsRaw.length} inspecciones (batch=${INSP_BATCH})…`);
    const startedI = Date.now();
    for (let i = 0; i < inspsRaw.length; i += INSP_BATCH) {
      const slice = inspsRaw.slice(i, i + INSP_BATCH);
      await Promise.all(slice.map(processInsp));
      if ((i + INSP_BATCH) % 2500 === 0 || (i + INSP_BATCH) >= inspsRaw.length) {
        const elapsed = Math.round((Date.now() - startedI) / 1000);
        console.log(`  insp ${Math.min(i + INSP_BATCH, inspsRaw.length)} / ${inspsRaw.length}   +${inspCreated}n  ${inspUpdated}u  ${inspSkipped}sk  (${elapsed}s)`);
      }
    }
  }
  console.log(`Inspecciones — created: ${inspCreated}  updated: ${inspUpdated}  skipped: ${inspSkipped}\n`);

  // ── Refresh analytics cache so CPK/health/depth fields are populated ─────
  // Three steps, each idempotent:
  //   A. Derive kilometrosRecorridos from inspection mileage range where the
  //      MERQUEPRO source didn't ship it (zero km) but the tire has ≥2
  //      inspections at different vehicle odometers.
  //   B. Recompute currentCpk = SUM(costos) / kilometrosRecorridos whenever
  //      we have both sides. Crucial: MERQUEPRO inspections carry NO cpk
  //      field, so the old refresh was wiping every tire's cpk to NULL.
  //   C. Sync latest inspection snapshot onto tire (depth, pressure, date).
  // ── Post-pass 0: position-collision cleanup ───────────────────────────────
  // Merquepro's /tires dump returns every tire that has ever been mounted
  // at a given position, so many (vehicleId, posicion) pairs end up with
  // 2+ tires after insert. Keep the one with the latest assembly date on
  // the vehicle; move the others to inventory (vehicleId = null,
  // inventoryBucketId = null, preserve lastVehicleId/lastVehiclePlaca).
  if (APPLY) {
    console.log('Resolving (vehicle, posicion) collisions…');
    const collisionFix = await prisma.$executeRawUnsafe(`
      WITH ranked AS (
        SELECT t.id, t."vehicleId", t."posicion",
               ROW_NUMBER() OVER (
                 PARTITION BY t."vehicleId", t."posicion"
                 ORDER BY COALESCE(t."fechaInstalacion", t."createdAt") DESC,
                          t."updatedAt" DESC,
                          t.id DESC
               ) AS rn
          FROM "Tire" t
         WHERE t."externalSourceId" LIKE 'merquepro:%'
           AND t."vehicleId" IS NOT NULL
           AND t."posicion" > 0
      ),
      losers AS (
        SELECT r.id, t."vehicleId", v.placa AS v_placa, t."posicion"
          FROM ranked r
          JOIN "Tire" t ON t.id = r.id
          LEFT JOIN "Vehicle" v ON v.id = r."vehicleId"
         WHERE r.rn > 1
      )
      UPDATE "Tire" t
         SET "vehicleId"          = NULL,
             "posicion"           = 0,
             "lastVehicleId"      = l."vehicleId",
             "lastVehiclePlaca"   = l.v_placa,
             "lastPosicion"       = l."posicion",
             "inventoryEnteredAt" = NOW()
        FROM losers l
       WHERE t.id = l.id
    `);
    console.log(`  resolved collisions: ${collisionFix} tires bumped to inventory`);
  }

  // ── Post-pass 1: multi-vida transitions logged as TireEventos ─────────────
  // Merquepro inspections carry vidaAlMomento per inspection. Walking
  // them chronologically and detecting state changes lets us reconstruct
  // the vida timeline (nueva → reencauche1 → reencauche2 → …). We log
  // each transition as a TireEvento (type=reencauche or retiro) rather
  // than writing tire_vida_snapshots — the snapshot table demands final-
  // life metrics (mm desgastados, días, etc.) we can't derive from
  // inspection-date transitions alone. TireEvento is the right fit for
  // "here's what happened to this tire and when". Idempotent: skips
  // transitions we've already logged for the same (tireId, to_vida).
  if (APPLY) {
    console.log('Reconstructing vida history from inspections…');
    const vidaPass = await prisma.$executeRawUnsafe(`
      WITH ordered AS (
        SELECT
          i.id,
          i."tireId",
          i."fecha",
          i."vidaAlMomento" AS vida,
          LAG(i."vidaAlMomento") OVER (
            PARTITION BY i."tireId" ORDER BY i."fecha" ASC, i.id ASC
          ) AS prev_vida
        FROM inspecciones i
        JOIN "Tire" t ON t.id = i."tireId"
        WHERE t."externalSourceId" LIKE 'merquepro:%'
      ),
      transitions AS (
        SELECT
          o."tireId",
          o.vida AS to_vida,
          o."fecha" AS transition_date
        FROM ordered o
        WHERE o.prev_vida IS NOT NULL
          AND o.prev_vida <> o.vida
          AND o.vida IN ('reencauche1','reencauche2','reencauche3','fin')
      )
      INSERT INTO tire_eventos (id, "tireId", tipo, fecha, notas, metadata, "createdAt")
      SELECT
        gen_random_uuid()::text,
        tr."tireId",
        CASE WHEN tr.to_vida = 'fin'
             THEN 'retiro'::"TireEventType"
             ELSE 'reencauche'::"TireEventType" END,
        tr.transition_date,
        tr.to_vida::text,
        jsonb_build_object('source', 'merquepro_vida_reconstruction',
                           'derived_from', 'inspection_state_transition'),
        NOW()
      FROM transitions tr
      WHERE NOT EXISTS (
        SELECT 1 FROM tire_eventos e
        WHERE e."tireId" = tr."tireId"
          AND e.notas    = tr.to_vida::text
          AND e.tipo IN ('reencauche'::"TireEventType",
                         'retiro'::"TireEventType",
                         'montaje'::"TireEventType")
      )
    `);
    console.log(`  vida transitions logged: ${vidaPass}`);
  }

  if (APPLY && !SKIP_REFRESH) {
    console.log('Refreshing analytics for merquepro tires…');
    // Only accept an inspection-odometer-diff ≥ 500 km. Smaller diffs are
    // noise (two inspections on the same vehicle odometer a day apart) and
    // dividing cost by that noise produces insanely-inflated CPKs.
    const a = await prisma.$executeRawUnsafe(`
      UPDATE "Tire" t
         SET "kilometrosRecorridos" = LEAST((ik.max_km - ik.min_km)::int, 250000)
        FROM (
          SELECT "tireId",
                 MIN("kmActualVehiculo") AS min_km,
                 MAX("kmActualVehiculo") AS max_km
            FROM inspecciones
           WHERE "kmActualVehiculo" IS NOT NULL AND "kmActualVehiculo" > 0
           GROUP BY "tireId"
          HAVING COUNT(*) >= 2
        ) ik
       WHERE t.id = ik."tireId"
         AND t."externalSourceId" LIKE 'merquepro:%'
         AND t."kilometrosRecorridos" = 0
         AND (ik.max_km - ik.min_km) >= 500
    `);
    console.log(`  (A) derived km from inspections: ${a} tires`);

    // Cap at 500 COP/km — anything higher is a data-quality artifact, not a
    // legitimate heavy-truck cost-per-km (typical range is 10-100 COP/km).
    const b = await prisma.$executeRawUnsafe(`
      UPDATE "Tire" t
         SET "currentCpk" = CASE
           WHEN (cs.total / t."kilometrosRecorridos") > 500 THEN NULL
           ELSE ROUND((cs.total / t."kilometrosRecorridos")::numeric, 2)
         END
        FROM (
          SELECT "tireId", SUM(valor)::numeric AS total
            FROM tire_costos
           GROUP BY "tireId"
        ) cs
       WHERE t.id = cs."tireId"
         AND t."externalSourceId" LIKE 'merquepro:%'
         AND t."kilometrosRecorridos" > 0
         AND cs.total > 0
    `);
    console.log(`  (B) recomputed currentCpk: ${b} tires`);

    const c = await prisma.$executeRawUnsafe(`
      UPDATE "Tire" t
         SET "lastInspeccionDate" = sub.fecha,
             "currentProfundidad" = sub.avg_depth,
             "currentPresionPsi"  = COALESCE(sub.presion, t."currentPresionPsi")
        FROM (
          SELECT DISTINCT ON ("tireId")
                 "tireId", "fecha",
                 ("profundidadInt" + "profundidadCen" + "profundidadExt") / 3 AS avg_depth,
                 "presionPsi" AS presion
            FROM inspecciones
           ORDER BY "tireId", "fecha" DESC
        ) sub
       WHERE t.id = sub."tireId"
         AND t."externalSourceId" LIKE 'merquepro:%'
    `);
    console.log(`  (C) synced latest inspection snapshot: ${c} tires`);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const bar = '─'.repeat(78);
  console.log(bar);
  console.log(`Summary`);
  console.log(bar);
  console.log(`Clients:      ${clients.length}`);
  console.log(`Vehicles:     ${vehicleCreated + vehicleUpdated} (+${vehicleCreated} new)`);
  console.log(`Tires:        ${tireCreated + tireUpdated} (+${tireCreated} new)`);
  console.log(`Inspecciones: ${inspCreated + inspUpdated} (+${inspCreated} new)`);
  console.log(bar);
  console.log(APPLY ? '✅ Applied.' : 'Dry-run. Re-run with --apply to write.');
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
