/* eslint-disable */
/**
 * Deep fix for Adispetrol SA: match every DB tire against its Excel row
 * and correct all drifted fields.
 *
 *   - Rename blank-ID placas ("auto-svc939-2") to clean 5-digit IDs
 *     (90001, 90002, ... — deliberately above the real Excel range).
 *   - Same-vehicle ID collisions keep the base ID + append "*".
 *   - Overwrite marca / diseno / dimension / eje / fechaInstalacion /
 *     profundidadInicial / kilometrosRecorridos from the Excel row.
 *   - Replace inspections so depths, date and km estimate all match.
 *   - Recompute cpk / cpkProyectado / kmProyectado for every inspection.
 *   - Roll up currentCpk / lifetimeCpk on the Tire.
 *
 * Safe to re-run; every write is idempotent.
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
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let y = parseInt(m[3], 10);
    if (y < 100) y += 2000;
    return new Date(Date.UTC(y, parseInt(m[1],10)-1, parseInt(m[2],10)));
  }
  const d = new Date(str);
  return isNaN(+d) ? null : d;
}

const LIMITE_LEGAL_MM = 2;
const MIN_MEANINGFUL_KM = 5_000;
const EXPECTED_KM = 80_000;

function calcCpk(totalCost, km, profInicial, minDepth) {
  const usable = Math.max(profInicial - LIMITE_LEGAL_MM, 0);
  const mmWorn = Math.max(profInicial - minDepth, 0);
  const mmLeft = Math.max(minDepth - LIMITE_LEGAL_MM, 0);
  let projectedKm = 0;
  if (usable > 0) {
    if (km > 0) {
      const wear = mmWorn > 0 ? km + (km / mmWorn) * mmLeft : 0;
      const fallback = km + (mmLeft / usable) * EXPECTED_KM;
      if (mmWorn <= 0) projectedKm = fallback;
      else {
        const conf = Math.min(mmWorn / usable, 1);
        projectedKm = wear * conf + fallback * (1 - conf);
      }
    } else projectedKm = EXPECTED_KM;
  }
  projectedKm = Math.round(projectedKm);
  let cpk = 0;
  if (km >= MIN_MEANINGFUL_KM) cpk = totalCost / km;
  else if (projectedKm > 0 && totalCost > 0) cpk = totalCost / projectedKm;
  const cpkProy = projectedKm > 0 ? totalCost / projectedKm : 0;
  return { cpk, cpkProy, projectedKm };
}

function canonicalMarca(raw) {
  const n = norm(raw);
  const map = {
    'continental': 'Continental', 'michelin': 'Michelin', 'goodyear': 'Goodyear',
    'good year':   'Goodyear',    'retectire': 'Retectire', 'reencol': 'Reencol',
    'remax':       'Remax',       'renoboy':   'Renoboy',   'renovando': 'Renovando',
    'ralson':      'Ralson',      'nexen tire':'NEXEN TIRE',
  };
  return map[n] ?? (raw || '').trim();
}

function normEje(s) {
  const n = norm(s);
  if (n.includes('direc')) return 'direccion';
  if (n.includes('trac'))  return 'traccion';
  if (n.includes('remol')) return 'remolque';
  if (n.includes('libre')) return 'libre';
  return 'libre';
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  const prisma = app.get(PrismaService);

  // ═════════════════════════════════════════════════════════════════════
  // Step 1 — read Excel, resolve placas (collision-aware)
  // ═════════════════════════════════════════════════════════════════════
  const wb = XLSX.readFile(EXCEL_PATH);
  const rawRows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { raw: false, defval: '' });
  console.log(`Excel rows: ${rawRows.length}`);

  // First pass: collect slots per ID to disambiguate duplicates with "*".
  const idSlots = new Map();
  for (const r of rawRows) {
    const id = String(r['ID'] ?? '').trim();
    const placa = norm(r['PLACA']);
    const pos   = parseInt(String(r['Posicion'] ?? '').trim(), 10);
    if (!id || !placa || !pos) continue;
    const slot = `${placa}|${pos}`;
    if (!idSlots.has(id)) idSlots.set(id, []);
    const arr = idSlots.get(id);
    if (!arr.includes(slot)) arr.push(slot);
  }
  for (const [, slots] of idSlots) slots.sort();

  function resolvePlaca(id, placa, pos) {
    const slots = idSlots.get(id) || [];
    const idx = slots.indexOf(`${placa}|${pos}`);
    if (idx <= 0) return id;
    return id + '*'.repeat(idx);
  }

  // Second pass: canonical map keyed by (vehicle, position).
  let blankCounter = 90_000;
  const canonical = new Map(); // key=`${placa}|${pos}` → { ...row, placa, fechaInst, tireKm, insp, ... }
  for (const r of rawRows) {
    const placa = norm(r['PLACA']);
    const pos   = parseInt(String(r['Posicion'] ?? '').trim(), 10);
    if (!placa || !pos) continue;
    const key = `${placa}|${pos}`;

    const rawId  = String(r['ID'] ?? '').trim();
    const tirePlaca = rawId ? resolvePlaca(rawId, placa, pos) : String(++blankCounter);

    const isReenc = String(r['Nueva/Reencauche'] ?? '').trim().toUpperCase() === 'R';
    const marca   = canonicalMarca(r['Marca']);
    const banda   = String(r['Banda Reencauche'] ?? '').trim();
    const diseno  = isReenc && banda ? banda : String(r['Diseño'] ?? '').trim();

    const kmAct   = parseFloat(String(r['Km Actual']  ?? '').replace(/[^\d.-]/g,'')) || 0;
    const kmMount = parseFloat(String(r['Km Montaje'] ?? '').replace(/[^\d.-]/g,'')) || 0;
    // Km Montaje = 0 means the tire was mounted when the vehicle was new
    // (original tire), so its lifetime km equals the current vehicle km.
    // Otherwise the tire km is the delta since it was installed.
    const tireKm = kmAct > 0
      ? (kmMount > 0 ? Math.max(0, kmAct - kmMount) : kmAct)
      : 0;

    const depths = {
      int: parseFloat(r['INT']) || 0,
      cen: parseFloat(r['CEN']) || 0,
      ext: parseFloat(r['EXT']) || 0,
    };
    const maxObs = Math.max(depths.int, depths.cen, depths.ext);
    const profInicial = Math.max(22, maxObs + 1);

    if (!canonical.has(key)) {
      canonical.set(key, {
        placa:            tirePlaca,
        vehiclePlaca:     placa,
        posicion:         pos,
        marca,
        diseno:           diseno.toLowerCase(),
        dimension:        String(r['Dimension'] ?? '').trim().toLowerCase(),
        eje:              normEje(r['Eje']),
        vidaActual:       isReenc ? 'reencauche1' : 'nueva',
        fechaInstalacion: parseDate(r['Fecha Montaje']) ?? new Date(),
        kilometrosRecorridos: tireKm,
        profundidadInicial: profInicial,
        inspecciones: [],
      });
    }
    const spec = canonical.get(key);
    spec.inspecciones.push({
      fecha: parseDate(r['Fecha Inspeccion']) ?? spec.fechaInstalacion,
      int:   depths.int,
      cen:   depths.cen,
      ext:   depths.ext,
      km:    tireKm,
    });
  }

  // ═════════════════════════════════════════════════════════════════════
  // Step 2 — vehicle map
  // ═════════════════════════════════════════════════════════════════════
  const vehicles = await prisma.vehicle.findMany({
    where: { companyId: COMPANY_ID },
    select: { id: true, placa: true },
  });
  const vehByPlaca = new Map(vehicles.map(v => [norm(v.placa), v]));

  // ═════════════════════════════════════════════════════════════════════
  // Step 3 — walk every canonical entry and fix the matching DB tire
  // ═════════════════════════════════════════════════════════════════════
  const stats = { placaRenamed: 0, tireUpdated: 0, inspReplaced: 0 };
  let i = 0, total = canonical.size;

  for (const [, spec] of canonical) {
    i++;
    const veh = vehByPlaca.get(spec.vehiclePlaca);
    if (!veh) continue;

    const tire = await prisma.tire.findFirst({
      where: { companyId: COMPANY_ID, vehicleId: veh.id, posicion: spec.posicion },
      include: { inspecciones: true, costos: true },
    });
    if (!tire) continue;

    // Rename placa if needed (auto-* → clean ID, or enforce collision "*").
    if (tire.placa !== spec.placa) {
      // Guard against another tire already owning the expected placa.
      const taken = await prisma.tire.findFirst({
        where: { companyId: COMPANY_ID, placa: spec.placa, NOT: { id: tire.id } },
      });
      if (!taken) {
        await prisma.tire.update({ where: { id: tire.id }, data: { placa: spec.placa } });
        stats.placaRenamed++;
      }
    }

    // Overwrite core fields.
    await prisma.tire.update({
      where: { id: tire.id },
      data: {
        marca:                spec.marca,
        diseno:               spec.diseno,
        dimension:            spec.dimension,
        eje:                  spec.eje,
        vidaActual:           spec.vidaActual,
        fechaInstalacion:     spec.fechaInstalacion,
        kilometrosRecorridos: spec.kilometrosRecorridos,
        profundidadInicial:   spec.profundidadInicial,
      },
    });
    stats.tireUpdated++;

    // Replace inspections with exactly what the Excel says.
    await prisma.inspeccion.deleteMany({ where: { tireId: tire.id } });
    for (const ins of spec.inspecciones) {
      const minDepth = Math.min(ins.int || 99, ins.cen || 99, ins.ext || 99);
      const totalCost = tire.costos.reduce((s, c) => s + (c.valor ?? 0), 0);
      const m = calcCpk(totalCost, ins.km, spec.profundidadInicial, minDepth);
      await prisma.inspeccion.create({
        data: {
          tireId: tire.id,
          fecha:  ins.fecha,
          profundidadInt: ins.int,
          profundidadCen: ins.cen,
          profundidadExt: ins.ext,
          cpk:             m.cpk,
          cpkProyectado:   m.cpkProy,
          cpt:             0,
          cptProyectado:   0,
          diasEnUso:       1,
          mesesEnUso:      0,
          kilometrosEstimados: ins.km,
          kmActualVehiculo: 0,
          kmEfectivos:    ins.km,
          kmProyectado:   m.projectedKm,
          vidaAlMomento:  spec.vidaActual,
          source:         'bulk_upload',
        },
      });
      stats.inspReplaced++;
    }

    // Fix the montaje event date/vida.
    await prisma.tireEvento.deleteMany({ where: { tireId: tire.id, tipo: 'montaje' } });
    await prisma.tireEvento.create({
      data: {
        tireId: tire.id, tipo: 'montaje', fecha: spec.fechaInstalacion,
        notas: spec.vidaActual, metadata: { source: 'deep_fix' },
      },
    });

    if (i % 100 === 0) process.stdout.write(`\r  ${i}/${total}`);
  }
  console.log(`\nStats:`, stats);

  // ═════════════════════════════════════════════════════════════════════
  // Step 4 — reencauche +90k first-life bump and lifetime cpk
  // ═════════════════════════════════════════════════════════════════════
  const FIRST_LIFE_KM = 90_000;
  await prisma.$executeRaw`
    UPDATE "Tire"
    SET "kilometrosRecorridos" = "kilometrosRecorridos" + ${FIRST_LIFE_KM}
    WHERE "companyId" = ${COMPANY_ID}
      AND "vidaActual" IN ('reencauche1','reencauche2','reencauche3')`;

  // Re-derive inspection cpk (lifetime-cost / lifetime-km with first-life offset)
  await prisma.$executeRaw`
    UPDATE inspecciones i
    SET "cpkProyectado" = CASE
          WHEN t."vidaActual" IN ('reencauche1','reencauche2','reencauche3')
            AND (i."kmProyectado" + ${FIRST_LIFE_KM}) > 0
            THEN sub.total / (i."kmProyectado" + ${FIRST_LIFE_KM})
          WHEN i."kmProyectado" > 0 THEN sub.total / i."kmProyectado"
          ELSE 0 END,
        cpk = CASE
          WHEN t."vidaActual" IN ('reencauche1','reencauche2','reencauche3')
            AND (COALESCE(i."kilometrosEstimados",0) + ${FIRST_LIFE_KM}) >= ${MIN_MEANINGFUL_KM}
            THEN sub.total / (COALESCE(i."kilometrosEstimados",0) + ${FIRST_LIFE_KM})
          WHEN COALESCE(i."kilometrosEstimados",0) >= ${MIN_MEANINGFUL_KM}
            THEN sub.total / i."kilometrosEstimados"
          WHEN i."kmProyectado" > 0 THEN sub.total / i."kmProyectado"
          ELSE 0 END
    FROM "Tire" t
    JOIN (SELECT "tireId", SUM(valor) AS total FROM tire_costos GROUP BY "tireId") sub
      ON sub."tireId" = t.id
    WHERE t."companyId" = ${COMPANY_ID} AND i."tireId" = t.id`;

  await prisma.$executeRaw`
    UPDATE "Tire" t
    SET "lifetimeCpk" = CASE
      WHEN t."kilometrosRecorridos" >= ${MIN_MEANINGFUL_KM} AND sub.total > 0
        THEN ROUND((sub.total / t."kilometrosRecorridos")::numeric, 2)
      ELSE NULL END,
      "currentCpk" = lastInsp.cpk,
      "currentCpt" = lastInsp.cpt,
      "lastInspeccionDate" = lastInsp.fecha
    FROM
      (SELECT "tireId", SUM(valor) AS total FROM tire_costos GROUP BY "tireId") sub,
      (SELECT DISTINCT ON (t.id) t.id AS tid, i.cpk, i.cpt, i.fecha
       FROM "Tire" t JOIN inspecciones i ON i."tireId" = t.id
       WHERE t."companyId" = ${COMPANY_ID}
       ORDER BY t.id, i.fecha DESC) lastInsp
    WHERE t."companyId" = ${COMPANY_ID}
      AND sub."tireId" = t.id
      AND lastInsp.tid = t.id`;

  // ═════════════════════════════════════════════════════════════════════
  // Report
  // ═════════════════════════════════════════════════════════════════════
  const byMarca = await prisma.$queryRaw`
    SELECT marca, COUNT(*)::int AS n,
           ROUND(AVG("currentCpk")::numeric, 0) AS curr,
           ROUND(AVG("lifetimeCpk")::numeric, 0) AS life,
           ROUND(AVG("kilometrosRecorridos")::numeric, 0) AS km
    FROM "Tire" WHERE "companyId" = ${COMPANY_ID}
    GROUP BY marca ORDER BY n DESC`;
  console.log('\nFinal by marca:');
  byMarca.forEach(r => console.log(`  ${r.marca.padEnd(15)} n=${String(r.n).padStart(4)}  curr=$${r.curr}  life=$${r.life}  avgKm=${r.km}`));

  const autoPlacas = await prisma.tire.count({
    where: { companyId: COMPANY_ID, placa: { startsWith: 'auto-' } },
  });
  console.log(`\nRemaining auto-* placas: ${autoPlacas}`);

  await app.close();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
