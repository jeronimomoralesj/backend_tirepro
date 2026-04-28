/* eslint-disable */
/**
 * Reconcile Adispetrol SA tires against the master Excel.
 *
 * Rules:
 *   - Each (PLACA, Posicion) in the Excel maps to exactly one tire.
 *   - If a tire ID appears on multiple vehicles in the Excel, the FIRST
 *     occurrence keeps the bare ID, each subsequent occurrence gets an
 *     extra "*" appended (ID, ID*, ID**, ...).
 *   - If the Excel has multiple rows for the same (vehicle, ID) those are
 *     multiple inspections of the same tire — keep them all.
 *   - The DB tire's vehicleId + posicion must match the Excel row.
 *   - The DB tire's inspections must only be from the same vehicle. Any
 *     inspection that doesn't correspond to an Excel row for this tire
 *     is deleted.
 *   - Tires in the DB with no matching Excel row are deleted (cascades).
 *
 * Run against production RDS. Safe in the sense that every write is a
 * no-op unless state actually differs.
 */

const path = require('path');
const DIST = path.resolve(__dirname, '..', 'dist');
const { NestFactory }   = require('@nestjs/core');
const { AppModule }     = require(path.join(DIST, 'app.module'));
const { PrismaService } = require(path.join(DIST, 'prisma/prisma.service'));

const XLSX       = require('xlsx');
const COMPANY_ID = '9f958ac8-39a3-4012-9695-a2e96ae9aee9';
const EXCEL_PATH = '/Users/jeronimo/Downloads/informacion actualizada remax (1) (1).xlsx';

const norm = (s) => String(s ?? '').trim().toLowerCase();

function parseDate(s) {
  const str = String(s ?? '').trim();
  if (!str) return null;
  // m/d/yy or m/d/yyyy
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const mo = parseInt(m[1], 10) - 1;
    const d  = parseInt(m[2], 10);
    let y    = parseInt(m[3], 10);
    if (y < 100) y += 2000;
    return new Date(Date.UTC(y, mo, d));
  }
  const d = new Date(str);
  return isNaN(+d) ? null : d;
}

async function main() {
  const app    = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  const prisma = app.get(PrismaService);

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 1 — build canonical map from Excel
  // ═══════════════════════════════════════════════════════════════════════

  const wb = XLSX.readFile(EXCEL_PATH);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { raw: false, defval: '' });
  console.log(`Excel rows: ${rows.length}`);

  // First pass: for every ID, collect the (placa, pos) slots it occupies.
  // Each unique (placa, pos) in the Excel is ONE distinct physical tire —
  // even when two rows accidentally share an ID. Assign a progressive "*"
  // suffix so every slot gets a unique placa downstream.
  const idSlots = new Map(); // id → [`${placa}|${pos}`, ...] ordered
  for (const r of rows) {
    const id = String(r['ID'] ?? '').trim();
    const placa = norm(r['PLACA']);
    const pos   = parseInt(String(r['Posicion'] ?? '').trim(), 10);
    if (!id || !placa || !pos) continue;
    const slot = `${placa}|${pos}`;
    if (!idSlots.has(id)) idSlots.set(id, []);
    const slots = idSlots.get(id);
    if (!slots.includes(slot)) slots.push(slot);
  }
  for (const [id, slots] of idSlots) slots.sort(); // deterministic order

  function resolvePlaca(id, vehiclePlaca, pos) {
    if (!id) return null;
    const slots = idSlots.get(id) || [];
    const idx = slots.indexOf(`${vehiclePlaca}|${pos}`);
    if (idx <= 0) return id;
    return id + '*'.repeat(idx);
  }

  // Second pass: build rows with resolved placa + inspection data.
  // When the Excel has multiple rows for the SAME (vehicle, pos, ID) those
  // are legitimate repeat inspections on the same tire — keep them all.
  const canonical = new Map();  // key=resolvedPlaca → { tire meta, inspections[] }
  let autoIdCounter = 0;
  for (const r of rows) {
    let id = String(r['ID'] ?? '').trim();
    const placa = norm(r['PLACA']);
    const pos   = parseInt(String(r['Posicion'] ?? '').trim(), 10);
    if (!placa || !pos) continue;

    // Blank IDs get a synthetic unique placa (stable across re-runs for the
    // same vehicle+position combo).
    let resolved;
    if (!id) {
      resolved = `auto-${placa}-${pos}`;
    } else {
      resolved = resolvePlaca(id, placa, pos);
    }
    if (!canonical.has(resolved)) {
      const isReenc = String(r['Nueva/Reencauche'] ?? '').trim().toUpperCase() === 'R';
      const marca   = String(r['Marca']  ?? '').trim();
      const diseno  = isReenc && String(r['Banda Reencauche'] ?? '').trim()
        ? String(r['Banda Reencauche']).trim()
        : String(r['Diseño'] ?? '').trim();
      canonical.set(resolved, {
        placa: resolved,
        vehiclePlaca: placa,
        posicion: pos,
        marca,
        diseno,
        eje:    String(r['Eje'] ?? '').trim(),
        vida:   isReenc ? 'reencauche1' : 'nueva',
        dimension: String(r['Dimension'] ?? '').trim(),
        fechaInstalacion: parseDate(r['Fecha Montaje']),
        inspecciones: [],
      });
    }
    canonical.get(resolved).inspecciones.push({
      fecha: parseDate(r['Fecha Inspeccion']),
      int:   parseFloat(r['INT']) || 0,
      cen:   parseFloat(r['CEN']) || 0,
      ext:   parseFloat(r['EXT']) || 0,
    });
  }

  const collisionIds = [...idSlots].filter(([, slots]) => slots.length > 1);
  console.log(`ID collisions (multi-slot) in Excel:  ${collisionIds.length}`);
  console.log(`Canonical tires expected:             ${canonical.size}`);

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 2 — load current DB state (vehicles + tires + inspections)
  // ═══════════════════════════════════════════════════════════════════════

  const vehicles = await prisma.vehicle.findMany({
    where:  { companyId: COMPANY_ID },
    select: { id: true, placa: true },
  });
  const vehByPlaca = new Map(vehicles.map(v => [norm(v.placa), v]));
  console.log(`DB vehicles: ${vehicles.length}`);

  const dbTires = await prisma.tire.findMany({
    where:  { companyId: COMPANY_ID },
    include: { inspecciones: { select: { id: true, fecha: true, profundidadInt: true, profundidadCen: true, profundidadExt: true } } },
  });
  const dbByPlaca = new Map(dbTires.map(t => [t.placa, t]));
  console.log(`DB tires: ${dbTires.length}`);

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 3 — reconciliation plan
  // ═══════════════════════════════════════════════════════════════════════

  const stats = {
    created: 0, updatedPlaca: 0, reassigned: 0,
    inspAdded: 0, inspDeleted: 0,
    dbOnlyDeleted: 0, vehicleMissing: 0,
  };

  // ── 3a. Handle rename collisions: if any DB tire already uses "<id>*"
  //       style placa we want to leave it if it matches a canonical tire,
  //       otherwise we may need to repurpose it. Use a by-ID index to look
  //       up DB rows whose placa starts with this ID.
  const dbByBaseId = new Map(); // baseId → [tire...]
  for (const t of dbTires) {
    const base = t.placa.replace(/\*+$/, '');
    if (!dbByBaseId.has(base)) dbByBaseId.set(base, []);
    dbByBaseId.get(base).push(t);
  }

  // ── 3b. Iterate canonical tires and drive the DB toward them ─────────
  for (const [expectedPlaca, spec] of canonical) {
    const veh = vehByPlaca.get(spec.vehiclePlaca);
    if (!veh) {
      stats.vehicleMissing++;
      console.log(`  ! vehicle ${spec.vehiclePlaca} missing, skipping ${expectedPlaca}`);
      continue;
    }

    let tire = dbByPlaca.get(expectedPlaca);
    // If the placa match was already claimed by a previous iteration (happens
    // when same-ID collisions renamed a tire), don't reuse it — treat as if
    // we didn't find one and create a new tire below.
    if (tire && tire._claimed) tire = null;

    // If exact placa doesn't exist, try to salvage from the base-id pool.
    if (!tire) {
      const baseId = expectedPlaca.replace(/\*+$/, '');
      const pool = (dbByBaseId.get(baseId) || []).filter(t => !t._claimed);
      // Prefer candidates already on the right vehicle+position.
      pool.sort((a, b) => {
        const aMatch = (a.vehicleId === veh.id && a.posicion === spec.posicion) ? 0 : 1;
        const bMatch = (b.vehicleId === veh.id && b.posicion === spec.posicion) ? 0 : 1;
        return aMatch - bMatch;
      });
      tire = pool.find(t => !t._claimed);
      if (tire && tire.placa !== expectedPlaca) {
        await prisma.tire.update({ where: { id: tire.id }, data: { placa: expectedPlaca } });
        tire.placa = expectedPlaca;
        dbByPlaca.set(expectedPlaca, tire);
        stats.updatedPlaca++;
      }
    }

    if (!tire) {
      // Create a brand new tire
      tire = await prisma.tire.create({
        data: {
          placa:              expectedPlaca,
          marca:              spec.marca,
          diseno:             spec.diseno.toLowerCase(),
          dimension:          (spec.dimension || '295/80 r 22.5').toLowerCase(),
          eje:                normEje(spec.eje),
          posicion:           spec.posicion,
          profundidadInicial: 22,
          companyId:          COMPANY_ID,
          vehicleId:          veh.id,
          fechaInstalacion:   spec.fechaInstalacion ?? new Date(),
          kilometrosRecorridos: 0,
          diasAcumulados:     1,
          alertLevel:         'ok',
          vidaActual:         spec.vida,
          totalVidas:         0,
          primeraVida:        [],
        },
        include: { inspecciones: true },
      });
      dbByPlaca.set(expectedPlaca, tire);
      stats.created++;
    } else {
      // Move to the right vehicle / position if wrong.
      if (tire.vehicleId !== veh.id || tire.posicion !== spec.posicion || tire.vidaActual === 'fin') {
        await prisma.tire.update({
          where: { id: tire.id },
          data:  {
            vehicleId: veh.id,
            posicion:  spec.posicion,
            vidaActual: spec.vida,
            lastVehicleId:    null,
            lastVehiclePlaca: null,
            lastPosicion:     0,
          },
        });
        await prisma.tireEvento.deleteMany({ where: { tireId: tire.id, tipo: 'retiro', notas: 'fin' } });
        tire.vehicleId = veh.id; tire.posicion = spec.posicion; tire.vidaActual = spec.vida;
        stats.reassigned++;
      }
    }
    tire._claimed = true;

    // ── Inspection sync ────────────────────────────────────────────────
    // Build a signature from (date, depths). Any DB inspection that isn't
    // in the expected set gets deleted; any expected row not present gets
    // inserted.
    const expectedSet = new Set(
      spec.inspecciones.map(i =>
        `${i.fecha ? i.fecha.toISOString().slice(0,10) : ''}|${i.int}|${i.cen}|${i.ext}`,
      ),
    );
    const keep = new Set();
    for (const insp of tire.inspecciones || []) {
      const key = `${insp.fecha ? insp.fecha.toISOString().slice(0,10) : ''}|${insp.profundidadInt}|${insp.profundidadCen}|${insp.profundidadExt}`;
      if (expectedSet.has(key)) keep.add(key);
      else {
        await prisma.inspeccion.delete({ where: { id: insp.id } });
        stats.inspDeleted++;
      }
    }
    for (const i of spec.inspecciones) {
      const key = `${i.fecha ? i.fecha.toISOString().slice(0,10) : ''}|${i.int}|${i.cen}|${i.ext}`;
      if (keep.has(key)) continue;
      await prisma.inspeccion.create({
        data: {
          tireId:          tire.id,
          fecha:           i.fecha ?? new Date(),
          profundidadInt:  i.int,
          profundidadCen:  i.cen,
          profundidadExt:  i.ext,
          vidaAlMomento:   spec.vida,
          cpk:             0,
          cpkProyectado:   0,
          cpt:             0,
          cptProyectado:   0,
          diasEnUso:       1,
          mesesEnUso:      0,
          kilometrosEstimados: 0,
          kmActualVehiculo: 0,
          kmEfectivos:     0,
          kmProyectado:    0,
          source:          'bulk_upload',
        },
      });
      stats.inspAdded++;
    }
  }

  // ── 3c. Delete tires that are not in the canonical list ──────────────
  for (const t of dbTires) {
    if (!t._claimed) {
      await prisma.tire.delete({ where: { id: t.id } });
      stats.dbOnlyDeleted++;
    }
  }

  console.log('\nReconciliation stats:');
  for (const [k, v] of Object.entries(stats)) console.log(`  ${k.padEnd(18)} ${v}`);

  // Final counts
  const total = await prisma.tire.count({ where: { companyId: COMPANY_ID } });
  const mounted = await prisma.tire.count({ where: { companyId: COMPANY_ID, vehicleId: { not: null } } });
  console.log(`\nFinal state: tires=${total}, mounted=${mounted}, expected=${canonical.size}`);

  await app.close();
}

function normEje(s) {
  const n = norm(s);
  if (n.includes('direc')) return 'direccion';
  if (n.includes('trac'))  return 'traccion';
  if (n.includes('remol')) return 'remolque';
  if (n.includes('libre')) return 'libre';
  return 'libre';
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
