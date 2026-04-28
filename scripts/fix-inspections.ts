/**
 * Data cleanup script — fixes inspection ordering, dates, KM, and profundidadInicial.
 *
 * 1. profundidadInicial < 16 → set to 20, or max observed depth + 1
 * 2. Sort inspections by depth descending (deepest = oldest)
 * 3. Deduplicate same-day inspections: keep smallest depth on actual date,
 *    space others backwards in time
 * 4. Ensure KM ascending order (inverse of depth)
 * 5. Re-estimate KM for every inspection based on wear
 * 6. Recalculate CPK metrics
 *
 * Usage:  npx tsx scripts/fix-inspections.ts
 *         npx tsx scripts/fix-inspections.ts --dry-run
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const KM_POR_MES       = 6_000;
const EXPECTED_KM      = 80_000;
const LIMITE_LEGAL_MM  = 2;
const MS_POR_DIA       = 86_400_000;

function minDepth(int: number, cen: number, ext: number): number {
  return Math.min(int || 99, cen || 99, ext || 99);
}

function avgDepth(int: number, cen: number, ext: number): number {
  return (int + cen + ext) / 3;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) console.log('*** DRY RUN ***\n');

  const tires = await prisma.tire.findMany({
    include: {
      inspecciones: { orderBy: { fecha: 'asc' } },
      costos:       { orderBy: { fecha: 'asc' } },
    },
  });

  console.log(`Loaded ${tires.length} tires with ${tires.reduce((s, t) => s + t.inspecciones.length, 0)} inspections.\n`);

  let fixedProfInicial = 0;
  let fixedOrder       = 0;
  let fixedDates       = 0;
  let fixedKm          = 0;
  let deduplicated     = 0;
  let tiresProcessed   = 0;

  for (const tire of tires) {
    if (tire.inspecciones.length === 0) continue;
    tiresProcessed++;

    let changed = false;
    const insps = [...tire.inspecciones];

    // ── Step 1: Fix profundidadInicial ────────────────────────────────────
    let profInicial = tire.profundidadInicial ?? 22;
    const maxObserved = Math.max(...insps.map(i => Math.max(i.profundidadInt, i.profundidadCen, i.profundidadExt)));

    if (profInicial < 16) {
      profInicial = Math.max(20, maxObserved + 1);
      fixedProfInicial++;
      changed = true;
    }
    // Also fix if any inspection has depths > profundidadInicial
    if (maxObserved >= profInicial) {
      profInicial = maxObserved + 1;
      fixedProfInicial++;
      changed = true;
    }

    // ── Step 2: Sort inspections by depth descending (deepest first = oldest) ─
    // This ensures chronological order matches wear progression.
    insps.sort((a, b) => {
      const aMin = minDepth(a.profundidadInt, a.profundidadCen, a.profundidadExt);
      const bMin = minDepth(b.profundidadInt, b.profundidadCen, b.profundidadExt);
      // Deepest first (highest mm = earliest inspection)
      return bMin - aMin || avgDepth(b.profundidadInt, b.profundidadCen, b.profundidadExt) - avgDepth(a.profundidadInt, a.profundidadCen, a.profundidadExt);
    });

    // Check if order changed from original
    const originalOrder = tire.inspecciones.map(i => i.id);
    const newOrder = insps.map(i => i.id);
    if (JSON.stringify(originalOrder) !== JSON.stringify(newOrder)) {
      fixedOrder++;
      changed = true;
    }

    // ── Step 3: Deduplicate + space dates ─────────────────────────────────
    // The last inspection (shallowest = most recent) keeps the latest real date.
    // Work backwards from the last inspection, spacing each prior one ≥1 day earlier.
    const lastInsp = insps[insps.length - 1];
    // Use the latest actual date from any inspection as the anchor
    const latestDate = new Date(Math.max(...tire.inspecciones.map(i => i.fecha.getTime())));

    // Remove exact duplicates (same depths on same inspection)
    const uniqueInsps: typeof insps = [];
    const seenKeys = new Set<string>();
    for (const insp of insps) {
      const key = `${insp.profundidadInt}|${insp.profundidadCen}|${insp.profundidadExt}`;
      if (seenKeys.has(key)) {
        deduplicated++;
        changed = true;
        continue;
      }
      seenKeys.add(key);
      uniqueInsps.push(insp);
    }

    // Assign dates: last (shallowest) gets the anchor date,
    // each prior one gets at least 1 day earlier
    const dateAssignments: { id: string; newFecha: Date }[] = [];
    let currentDate = new Date(latestDate);

    for (let i = uniqueInsps.length - 1; i >= 0; i--) {
      const insp = uniqueInsps[i];
      if (i === uniqueInsps.length - 1) {
        // Last inspection → anchor date
        if (insp.fecha.getTime() !== currentDate.getTime()) {
          dateAssignments.push({ id: insp.id, newFecha: new Date(currentDate) });
          changed = true;
          fixedDates++;
        }
      } else {
        // Prior inspection → must be before currentDate
        const nextDate = dateAssignments.length > 0
          ? dateAssignments[dateAssignments.length - 1].newFecha
          : currentDate;

        // Calculate spacing: proportional to depth difference
        const thisMin = minDepth(insp.profundidadInt, insp.profundidadCen, insp.profundidadExt);
        const nextInsp = uniqueInsps[i + 1];
        const nextMin = minDepth(nextInsp.profundidadInt, nextInsp.profundidadCen, nextInsp.profundidadExt);
        const depthDiff = thisMin - nextMin;

        // Estimate days between inspections from wear rate
        // Assume ~1mm per month at 6000km/month
        const estimatedDaysGap = Math.max(Math.round(depthDiff * 30), 7); // at least 7 days apart

        const prevDate = new Date(nextDate.getTime() - estimatedDaysGap * MS_POR_DIA);

        if (insp.fecha.getTime() !== prevDate.getTime()) {
          dateAssignments.push({ id: insp.id, newFecha: prevDate });
          changed = true;
          fixedDates++;
        }

        currentDate = prevDate;
      }
    }

    // ── Step 4 & 5: Re-estimate KM for every inspection ──────────────────
    // KM should be ascending (more km = more wear = less depth)
    const usableDepth = profInicial - LIMITE_LEGAL_MM;
    const kmAssignments: { id: string; newKm: number }[] = [];

    for (let i = 0; i < uniqueInsps.length; i++) {
      const insp = uniqueInsps[i];
      const thisMin = minDepth(insp.profundidadInt, insp.profundidadCen, insp.profundidadExt);
      const mmWorn = profInicial - thisMin;

      // KM estimate from wear: (expectedLifetime / usableDepth) * mmWorn
      let estimatedKm = 0;
      if (usableDepth > 0 && mmWorn > 0) {
        estimatedKm = Math.round((EXPECTED_KM / usableDepth) * mmWorn);
      } else if (i > 0) {
        // If no wear from initial, use a small increment from the previous
        const prevKm = kmAssignments[i - 1]?.newKm ?? 0;
        estimatedKm = prevKm + KM_POR_MES;
      }

      // Ensure strictly ascending
      if (i > 0) {
        const prevKm = kmAssignments[i - 1]?.newKm ?? 0;
        if (estimatedKm <= prevKm) {
          estimatedKm = prevKm + KM_POR_MES; // at least 6000 km more
        }
      }

      if (insp.kilometrosEstimados !== estimatedKm) {
        kmAssignments.push({ id: insp.id, newKm: estimatedKm });
        changed = true;
        fixedKm++;
      } else {
        kmAssignments.push({ id: insp.id, newKm: estimatedKm });
      }
    }

    // ── Step 6: Fix tire's fechaInstalacion ───────────────────────────────
    // Must be before the first inspection
    const firstInspDate = dateAssignments.find(d => d.id === uniqueInsps[0]?.id)?.newFecha
      ?? uniqueInsps[0]?.fecha;
    let newFechaInstalacion: Date | null = null;
    if (firstInspDate && tire.fechaInstalacion && tire.fechaInstalacion.getTime() >= firstInspDate.getTime()) {
      // fechaInstalacion should be before first inspection
      newFechaInstalacion = new Date(firstInspDate.getTime() - 30 * MS_POR_DIA); // 1 month before
      changed = true;
    }

    // ── Apply changes ─────────────────────────────────────────────────────
    if (!changed) continue;

    // Pause every 100 tires to avoid overwhelming the DB connection
    if (tiresProcessed % 100 === 0 && tiresProcessed > 0) {
      await new Promise(r => setTimeout(r, 500));
    }

    if (dryRun) {
      if (tiresProcessed <= 5) {
        console.log(`Tire ${tire.placa} (${tire.id.slice(0, 8)}):`);
        console.log(`  profInicial: ${tire.profundidadInicial} → ${profInicial}`);
        console.log(`  inspections: ${tire.inspecciones.length} → ${uniqueInsps.length} (${tire.inspecciones.length - uniqueInsps.length} deduped)`);
        uniqueInsps.forEach((insp, i) => {
          const da = dateAssignments.find(d => d.id === insp.id);
          const ka = kmAssignments[i];
          console.log(`    ${i + 1}. depths: ${insp.profundidadInt}/${insp.profundidadCen}/${insp.profundidadExt} | date: ${(da?.newFecha ?? insp.fecha).toISOString().slice(0, 10)} | km: ${ka?.newKm}`);
        });
      }
      continue;
    }

    // Delete duplicates + update tire + update inspections in a single transaction
    try {
      const keepIds = new Set(uniqueInsps.map(i => i.id));
      const deleteIds = tire.inspecciones.filter(i => !keepIds.has(i.id)).map(i => i.id);

      const tireUpdate: any = { profundidadInicial: profInicial };
      if (newFechaInstalacion) tireUpdate.fechaInstalacion = newFechaInstalacion;
      const lastKm = kmAssignments[kmAssignments.length - 1]?.newKm ?? tire.kilometrosRecorridos;
      tireUpdate.kilometrosRecorridos = lastKm;

      // Build all inspection update operations
      const totalCost = tire.costos.reduce((s, c) => s + c.valor, 0);
      const installDate = newFechaInstalacion ?? tire.fechaInstalacion ?? new Date();

      const inspOps = uniqueInsps.map((insp, i) => {
        const da = dateAssignments.find(d => d.id === insp.id);
        const ka = kmAssignments[i];
        const thisMin = minDepth(insp.profundidadInt, insp.profundidadCen, insp.profundidadExt);
        const mmWorn = profInicial - thisMin;
        const mmLeft = Math.max(thisMin - LIMITE_LEGAL_MM, 0);
        const km = ka?.newKm ?? insp.kilometrosEstimados ?? 0;
        const cpk = km > 0 ? totalCost / km : (EXPECTED_KM > 0 && totalCost > 0 ? totalCost / EXPECTED_KM : 0);
        let projectedKm = 0;
        if (usableDepth > 0 && km > 0 && mmWorn > 0) projectedKm = Math.round(km + (km / mmWorn) * mmLeft);
        else if (usableDepth > 0) projectedKm = EXPECTED_KM;
        const cpkProyectado = projectedKm > 0 && totalCost > 0 ? totalCost / projectedKm : 0;
        const inspFecha = da?.newFecha ?? insp.fecha;
        const diasEnUso = Math.max(Math.floor((inspFecha.getTime() - installDate.getTime()) / MS_POR_DIA), 1);
        const mesesEnUso = diasEnUso / 30;
        const cpt = mesesEnUso > 0 ? totalCost / mesesEnUso : 0;
        const projectedMonths = projectedKm > 0 ? projectedKm / KM_POR_MES : 0;
        const cptProyectado = projectedMonths > 0 && totalCost > 0 ? totalCost / projectedMonths : 0;

        const data: any = {
          kilometrosEstimados: km, kmEfectivos: km, kmProyectado: projectedKm,
          cpk: Math.round(cpk * 100) / 100, cpkProyectado: Math.round(cpkProyectado * 100) / 100,
          cpt: Math.round(cpt * 100) / 100, cptProyectado: Math.round(cptProyectado * 100) / 100,
          diasEnUso, mesesEnUso: Math.round(mesesEnUso * 100) / 100,
        };
        if (da) data.fecha = da.newFecha;
        return prisma.inspeccion.update({ where: { id: insp.id }, data });
      });

      // Execute all writes as a transaction (single round trip)
      await prisma.$transaction([
        ...(deleteIds.length > 0 ? [prisma.inspeccion.deleteMany({ where: { id: { in: deleteIds } } })] : []),
        prisma.tire.update({ where: { id: tire.id }, data: tireUpdate }),
        ...inspOps,
      ]);
    } catch (err: any) {
      console.log(`  ✗ Error on tire ${tire.placa}: ${err.message?.slice(0, 80)}`);
      // Reconnect and continue
      await new Promise(r => setTimeout(r, 2000));
    }

    if (tiresProcessed % 200 === 0) {
      console.log(`  ... processed ${tiresProcessed} tires`);
    }
  }

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  Tires processed:        ${tiresProcessed}`);
  console.log(`  profundidadInicial fixed: ${fixedProfInicial}`);
  console.log(`  Inspection order fixed:  ${fixedOrder}`);
  console.log(`  Dates re-spaced:        ${fixedDates}`);
  console.log(`  KM re-estimated:        ${fixedKm}`);
  console.log(`  Duplicates removed:     ${deduplicated}`);
  console.log('═'.repeat(50));

  await prisma.$disconnect();
}

main().catch(e => { console.error('Fatal:', e); prisma.$disconnect(); process.exit(1); });
