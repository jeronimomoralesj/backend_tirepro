/**
 * Comprehensive tire data cleanup script.
 *
 * 1. Deduplicate position conflicts: if two tires share (vehicleId, posicion),
 *    keep the one with MORE mm left on latest inspection and retire the others
 *    (vida = fin, unassign from vehicle).
 * 2. Fix profundidadInicial < 16: set to 20 (or max observed + 1 if higher),
 *    then recalculate CPK/CPK proyectado/health on all inspections.
 * 3. Enforce inspection order within each vida stage: deepest first, shallowest
 *    last. Vida transitions (reencauche events) reset the reference depth.
 *
 * Usage:
 *   npx tsx scripts/cleanup-tires.ts              # full run
 *   npx tsx scripts/cleanup-tires.ts --dry-run     # preview only
 */

import { PrismaClient, VidaValue, TireEventType } from '@prisma/client';

const prisma = new PrismaClient();

// ── Constants ────────────────────────────────────────────────────────────────
const MIN_PROFUNDIDAD_INICIAL = 16;
const DEFAULT_PROFUNDIDAD     = 20;
const LIMITE_LEGAL_MM         = 2;
const EXPECTED_KM             = 80_000;
const KM_POR_MES              = 6_000;
const MS_POR_DIA              = 86_400_000;

// ── Helpers ──────────────────────────────────────────────────────────────────
const minDepth = (int: number, cen: number, ext: number) =>
  Math.min(int || 99, cen || 99, ext || 99);

const avgDepth = (int: number, cen: number, ext: number) =>
  (int + cen + ext) / 3;

function calcHealthScore(profInicial: number, minDepthMm: number, profundidadInt: number, profundidadCen: number, profundidadExt: number): number {
  const usable = Math.max(profInicial - LIMITE_LEGAL_MM, 1);
  const remaining = Math.max(minDepthMm - LIMITE_LEGAL_MM, 0);
  const baseScore = Math.round((remaining / usable) * 100);

  // Penalty for irregular wear
  const diffs = [
    Math.abs(profundidadInt - profundidadCen),
    Math.abs(profundidadCen - profundidadExt),
    Math.abs(profundidadInt - profundidadExt),
  ];
  const maxDiff = Math.max(...diffs);
  const irregularPenalty = Math.min(maxDiff * 5, 25);

  return Math.max(0, Math.min(100, baseScore - irregularPenalty));
}

function calcCpkMetrics(
  totalCost: number,
  km: number,
  meses: number,
  profundidadInicial: number,
  minDepthMm: number,
) {
  const usableDepth = profundidadInicial - LIMITE_LEGAL_MM;
  const mmWorn      = profundidadInicial - minDepthMm;
  const mmLeft      = Math.max(minDepthMm - LIMITE_LEGAL_MM, 0);

  let projectedKm = 0;
  if (usableDepth > 0) {
    if (km > 0) {
      const wearEstimate = mmWorn > 0 ? km + (km / mmWorn) * mmLeft : 0;
      const fallbackEstimate = km + (mmLeft / usableDepth) * EXPECTED_KM;
      if (mmWorn <= 0) projectedKm = fallbackEstimate;
      else {
        const wearConf = Math.min(mmWorn / usableDepth, 1);
        projectedKm = wearEstimate * wearConf + fallbackEstimate * (1 - wearConf);
      }
    } else {
      projectedKm = EXPECTED_KM;
    }
  }
  projectedKm = Math.round(projectedKm);

  const cpk = km > 0 ? totalCost / km : (projectedKm > 0 && totalCost > 0 ? totalCost / projectedKm : 0);
  const cpkProyectado = projectedKm > 0 && totalCost > 0 ? totalCost / projectedKm : 0;
  const cpt = meses > 0 ? totalCost / meses : 0;
  const projectedMonths = projectedKm / KM_POR_MES;
  const cptProyectado = projectedMonths > 0 && totalCost > 0 ? totalCost / projectedMonths : 0;

  return {
    cpk: Math.round(cpk * 100) / 100,
    cpkProyectado: Math.round(cpkProyectado * 100) / 100,
    cpt: Math.round(cpt * 100) / 100,
    cptProyectado: Math.round(cptProyectado * 100) / 100,
    projectedKm,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Tire Cleanup Script');
  console.log('═══════════════════════════════════════════════════════════════');
  if (dryRun) console.log('  *** DRY RUN — no writes ***\n');

  let stats = {
    positionDupesFound:    0,
    tiresRetiredFromDupe:  0,
    profInicialFixed:      0,
    inspectionsReordered:  0,
    inspectionsRecalc:     0,
    tiresProcessed:        0,
  };

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 1: Deduplicate tires at the same (vehicleId, posicion)
  // ────────────────────────────────────────────────────────────────────────────
  console.log('STEP 1: Finding position conflicts...');

  const positionGroups = await prisma.tire.groupBy({
    by: ['vehicleId', 'posicion'],
    where: {
      vehicleId: { not: null },
      posicion:  { gt: 0 },
      vidaActual: { not: VidaValue.fin },
    },
    _count: true,
    having: { id: { _count: { gt: 1 } } },
  });

  console.log(`  Found ${positionGroups.length} (vehicle, position) pairs with multiple tires`);
  stats.positionDupesFound = positionGroups.length;

  for (const group of positionGroups) {
    const tiresAtPosition = await prisma.tire.findMany({
      where: {
        vehicleId:  group.vehicleId,
        posicion:   group.posicion,
        vidaActual: { not: VidaValue.fin },
      },
      include: {
        inspecciones: { orderBy: { fecha: 'desc' }, take: 1 },
        vehicle:      { select: { placa: true } },
      },
    });

    // Rank by min depth in latest inspection — the one with MORE mm stays
    // (newer tire, less worn), the others get retired.
    const ranked = tiresAtPosition.map(t => {
      const latest = t.inspecciones[0];
      const md = latest
        ? minDepth(latest.profundidadInt, latest.profundidadCen, latest.profundidadExt)
        : t.profundidadInicial;
      return { tire: t, minD: md };
    }).sort((a, b) => b.minD - a.minD); // highest first

    const keeper = ranked[0];
    const losers = ranked.slice(1);

    const placa = keeper.tire.vehicle?.placa ?? 'unknown';
    console.log(`  ${placa} pos ${group.posicion}: keeping ${keeper.tire.placa} (${keeper.minD}mm), retiring ${losers.map(l => `${l.tire.placa}(${l.minD}mm)`).join(', ')}`);

    if (dryRun) continue;

    for (const loser of losers) {
      try {
        await prisma.$transaction([
          prisma.tire.update({
            where: { id: loser.tire.id },
            data: {
              vidaActual:         VidaValue.fin,
              vehicleId:          null,
              posicion:           0,
              lastVehicleId:      loser.tire.vehicleId ?? null,
              lastVehiclePlaca:   placa,
              lastPosicion:       loser.tire.posicion ?? 0,
              inventoryEnteredAt: new Date(),
            },
          }),
          prisma.tireEvento.create({
            data: {
              tireId: loser.tire.id,
              tipo:   TireEventType.retiro,
              fecha:  new Date(),
              notas:  VidaValue.fin,
              metadata: JSON.stringify({
                reason:   'position_conflict_cleanup',
                winner:   keeper.tire.id,
                position: group.posicion,
              }) as any,
            },
          }),
        ]);
        stats.tiresRetiredFromDupe++;
      } catch (err: any) {
        console.log(`    ✗ Failed to retire ${loser.tire.placa}: ${err.message?.slice(0, 60)}`);
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 2 + 3: Fix profundidadInicial and reorder inspections per tire
  // ────────────────────────────────────────────────────────────────────────────
  console.log('\nSTEP 2+3: Fixing profundidadInicial and inspection order...');

  const tires = await prisma.tire.findMany({
    include: {
      inspecciones: { orderBy: { fecha: 'asc' } },
      eventos:      { orderBy: { fecha: 'asc' } },
      costos:       { orderBy: { fecha: 'asc' } },
    },
  });

  console.log(`  Loaded ${tires.length} tires with ${tires.reduce((s, t) => s + t.inspecciones.length, 0)} inspections.`);

  for (const tire of tires) {
    stats.tiresProcessed++;
    if (tire.inspecciones.length === 0) continue;

    // ── Fix profundidadInicial ─────────────────────────────────────────────
    let profInicial = tire.profundidadInicial ?? DEFAULT_PROFUNDIDAD;
    const maxObserved = Math.max(
      ...tire.inspecciones.map(i => Math.max(i.profundidadInt, i.profundidadCen, i.profundidadExt)),
    );

    let profChanged = false;
    if (profInicial < MIN_PROFUNDIDAD_INICIAL) {
      profInicial = Math.max(DEFAULT_PROFUNDIDAD, maxObserved + 1);
      profChanged = true;
    }
    if (maxObserved >= profInicial) {
      profInicial = maxObserved + 1;
      profChanged = true;
    }
    if (profChanged) stats.profInicialFixed++;

    // ── Group inspections by vida stage ─────────────────────────────────────
    // Each reencauche event starts a new vida stage. Within a stage, depths
    // should decrease over time.
    type VidaStage = { vida: string; startDate: Date; endDate: Date; inspecciones: typeof tire.inspecciones };
    const stages: VidaStage[] = [];

    // Build a chronological list of vida transitions from eventos
    const vidaEvents = tire.eventos
      .filter(e => {
        const notas = (e.notas || '').toLowerCase();
        return notas === 'nueva' || notas.startsWith('reencauche') || notas === 'fin'
          || e.tipo === TireEventType.reencauche;
      })
      .sort((a, b) => a.fecha.getTime() - b.fecha.getTime());

    // If no vida events, treat everything as one "nueva" stage
    if (vidaEvents.length === 0) {
      stages.push({
        vida: 'nueva',
        startDate: tire.fechaInstalacion ?? new Date(0),
        endDate: new Date(8640000000000000),
        inspecciones: tire.inspecciones,
      });
    } else {
      // Implicit "nueva" stage before the first event (if any)
      const firstEvent = vidaEvents[0];
      if (firstEvent.notas !== 'nueva' && tire.inspecciones.some(i => i.fecha < firstEvent.fecha)) {
        stages.push({
          vida: 'nueva',
          startDate: tire.fechaInstalacion ?? new Date(0),
          endDate: firstEvent.fecha,
          inspecciones: tire.inspecciones.filter(i => i.fecha < firstEvent.fecha),
        });
      }
      // One stage per vida event
      for (let i = 0; i < vidaEvents.length; i++) {
        const evt = vidaEvents[i];
        const nextEvt = vidaEvents[i + 1];
        const stageStart = evt.fecha;
        const stageEnd = nextEvt ? nextEvt.fecha : new Date(8640000000000000);
        const stageInsps = tire.inspecciones.filter(insp =>
          insp.fecha >= stageStart && insp.fecha < stageEnd
        );
        if (stageInsps.length > 0) {
          stages.push({
            vida: (evt.notas || 'nueva').toLowerCase(),
            startDate: stageStart,
            endDate: stageEnd,
            inspecciones: stageInsps,
          });
        }
      }
    }

    // ── Check order within each stage (deepest first, shallowest last) ─────
    let stageOrderChanged = false;
    const reorderedInsps: typeof tire.inspecciones = [];
    for (const stage of stages) {
      const sorted = [...stage.inspecciones].sort((a, b) => {
        const aMin = minDepth(a.profundidadInt, a.profundidadCen, a.profundidadExt);
        const bMin = minDepth(b.profundidadInt, b.profundidadCen, b.profundidadExt);
        return bMin - aMin || avgDepth(b.profundidadInt, b.profundidadCen, b.profundidadExt) - avgDepth(a.profundidadInt, a.profundidadCen, a.profundidadExt);
      });

      // If the order changed, we need to re-space dates so earliest-mm stays
      // at the latest date in the stage, and deeper ones go backwards.
      const origOrder = stage.inspecciones.map(i => i.id).join(',');
      const newOrder  = sorted.map(i => i.id).join(',');
      if (origOrder !== newOrder) {
        stageOrderChanged = true;
        // Pull the latest date in the stage as the anchor for the shallowest
        const latestDateInStage = new Date(Math.max(...stage.inspecciones.map(i => i.fecha.getTime())));

        // Assign new dates: shallowest → latest, then backwards
        for (let i = sorted.length - 1; i >= 0; i--) {
          const insp = sorted[i];
          if (i === sorted.length - 1) {
            (insp as any)._newDate = latestDateInStage;
          } else {
            const nextInsp = sorted[i + 1];
            const thisMin = minDepth(insp.profundidadInt, insp.profundidadCen, insp.profundidadExt);
            const nextMin = minDepth(nextInsp.profundidadInt, nextInsp.profundidadCen, nextInsp.profundidadExt);
            const depthDiff = Math.max(thisMin - nextMin, 0.1);
            // Estimate ~1mm per month
            const daysGap = Math.max(Math.round(depthDiff * 30), 7);
            const nextDate = (nextInsp as any)._newDate ?? nextInsp.fecha;
            (insp as any)._newDate = new Date(nextDate.getTime() - daysGap * MS_POR_DIA);
          }
        }
      }
      reorderedInsps.push(...sorted);
    }

    if (stageOrderChanged) stats.inspectionsReordered++;

    // ── Recalculate CPK and health for every inspection ────────────────────
    const totalCost = tire.costos.reduce((s, c) => s + c.valor, 0);
    const installDate = tire.fechaInstalacion ?? new Date();

    const updates: { id: string; data: any }[] = [];
    for (let i = 0; i < reorderedInsps.length; i++) {
      const insp = reorderedInsps[i];
      const inspFecha = (insp as any)._newDate ?? insp.fecha;
      const thisMin = minDepth(insp.profundidadInt, insp.profundidadCen, insp.profundidadExt);
      const diasEnUso = Math.max(
        Math.floor((inspFecha.getTime() - installDate.getTime()) / MS_POR_DIA),
        1,
      );
      const mesesEnUso = diasEnUso / 30;

      // KM estimation from wear progression
      const usableDepth = profInicial - LIMITE_LEGAL_MM;
      const mmWorn = profInicial - thisMin;
      let km = 0;
      if (usableDepth > 0 && mmWorn > 0) {
        km = Math.round((EXPECTED_KM / usableDepth) * mmWorn);
      } else if (mesesEnUso > 0.5) {
        km = Math.round(mesesEnUso * KM_POR_MES);
      }

      const metrics = calcCpkMetrics(totalCost, km, mesesEnUso, profInicial, thisMin);

      const data: any = {
        kilometrosEstimados: km,
        kmEfectivos:         km,
        kmProyectado:        metrics.projectedKm,
        cpk:                 metrics.cpk,
        cpkProyectado:       metrics.cpkProyectado,
        cpt:                 metrics.cpt,
        cptProyectado:       metrics.cptProyectado,
        diasEnUso,
        mesesEnUso:          Math.round(mesesEnUso * 100) / 100,
      };
      if ((insp as any)._newDate) data.fecha = (insp as any)._newDate;

      // Only push the update if something actually changed
      const needsUpdate =
        insp.kilometrosEstimados !== km ||
        Math.abs((insp.cpk ?? 0) - metrics.cpk) > 0.01 ||
        Math.abs((insp.cpkProyectado ?? 0) - metrics.cpkProyectado) > 0.01 ||
        (insp as any)._newDate;

      if (needsUpdate) updates.push({ id: insp.id, data });
    }

    // ── Apply tire and inspection updates in one transaction ──────────────
    if (!profChanged && updates.length === 0 && !stageOrderChanged) continue;
    stats.inspectionsRecalc += updates.length;

    if (dryRun) continue;

    try {
      const latestKm = updates.length > 0
        ? updates[updates.length - 1].data.kilometrosEstimados
        : tire.kilometrosRecorridos;

      // Last inspection's min depth → update the tire's health score
      const lastInsp = reorderedInsps[reorderedInsps.length - 1];
      const lastMin = minDepth(lastInsp.profundidadInt, lastInsp.profundidadCen, lastInsp.profundidadExt);
      const healthScore = calcHealthScore(profInicial, lastMin, lastInsp.profundidadInt, lastInsp.profundidadCen, lastInsp.profundidadExt);

      await prisma.$transaction([
        prisma.tire.update({
          where: { id: tire.id },
          data: {
            profundidadInicial:    profInicial,
            kilometrosRecorridos:  latestKm,
            healthScore,
          },
        }),
        ...updates.map(u => prisma.inspeccion.update({ where: { id: u.id }, data: u.data })),
      ]);
    } catch (err: any) {
      console.log(`  ✗ ${tire.placa}: ${err.message?.slice(0, 80)}`);
    }

    // Throttle every 100 tires to avoid DB pressure
    if (stats.tiresProcessed % 100 === 0) {
      console.log(`    ... ${stats.tiresProcessed}/${tires.length}`);
      await new Promise(r => setTimeout(r, 300));
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Summary');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Position conflicts resolved:  ${stats.positionDupesFound}`);
  console.log(`  Tires retired (dupes):        ${stats.tiresRetiredFromDupe}`);
  console.log(`  profundidadInicial fixed:     ${stats.profInicialFixed}`);
  console.log(`  Tires with reordered insp:    ${stats.inspectionsReordered}`);
  console.log(`  Inspections recalculated:     ${stats.inspectionsRecalc}`);
  console.log(`  Tires processed:              ${stats.tiresProcessed}`);
  console.log('═══════════════════════════════════════════════════════════════');

  await prisma.$disconnect();
}

main().catch(e => {
  console.error('Fatal:', e);
  prisma.$disconnect();
  process.exit(1);
});
