/**
 * audit-inspections.ts
 *
 * Walks every tire → every inspection and verifies CPK, CPK proyectado,
 * projected km, and km consistency.  Fixes any incorrect values in-place.
 *
 * Usage:  npx tsx scripts/audit-inspections.ts [--dry-run]
 */

import { PrismaClient, VidaValue, EjeType } from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');

// ─── Constants (mirror tire.service.ts) ─────────────────────────────────────

const C = {
  KM_POR_MES:                6_000,
  MS_POR_DIA:                86_400_000,
  LIMITE_LEGAL_MM:           2,
  STANDARD_TIRE_EXPECTED_KM: 100_000,
  PREMIUM_TIRE_EXPECTED_KM:  120_000,
  SIGNIFICANT_WEAR_MM:       10,
  PREMIUM_TIRE_THRESHOLD:    2_100_000,
} as const;

const VALID_VIDA = new Set<string>([
  'nueva','reencauche1','reencauche2','reencauche3','fin',
]);

// ─── Math helpers (exact copy from tire.service.ts — FIXED versions) ────────

function calcMinDepth(i: number, c: number, e: number) {
  return Math.min(i, c, e);
}

interface CpkMetrics {
  cpk: number;
  cpt: number;
  cpkProyectado: number;
  cptProyectado: number;
  projectedKm: number;
  projectedMonths: number;
}

function calcCpkMetrics(
  totalCost: number,
  km: number,
  meses: number,
  profundidadInicial: number,
  minDepth: number,
): CpkMetrics {
  const cpk = km    > 0 ? totalCost / km    : 0;
  const cpt = meses > 0 ? totalCost / meses : 0;

  const usableDepth = profundidadInicial - C.LIMITE_LEGAL_MM;
  const mmWorn      = profundidadInicial - minDepth;
  const mmLeft      = Math.max(minDepth - C.LIMITE_LEGAL_MM, 0);
  let   projectedKm = 0;

  if (usableDepth > 0 && km > 0) {
    const wearEstimate    = mmWorn > 0 ? km + (km / mmWorn) * mmLeft : 0;
    const fallbackEstimate = km + (mmLeft / usableDepth) * C.STANDARD_TIRE_EXPECTED_KM;

    if (mmWorn <= 0) {
      projectedKm = fallbackEstimate;
    } else {
      const wearConfidence = Math.min(mmWorn / usableDepth, 1);
      projectedKm = wearEstimate * wearConfidence + fallbackEstimate * (1 - wearConfidence);
    }
  }

  const projectedMonths = projectedKm / C.KM_POR_MES;
  const cpkProyectado   = projectedKm     > 0 ? totalCost / projectedKm     : 0;
  const cptProyectado   = projectedMonths > 0 ? totalCost / projectedMonths : 0;

  return { cpk, cpt, cpkProyectado, cptProyectado, projectedKm, projectedMonths };
}

function resolveVidaStartDate(
  eventos: { fecha: Date; notas: string | null }[],
  vida: VidaValue,
  installationDate: Date,
): Date {
  const evt = [...eventos]
    .filter(e => e.notas === vida)
    .sort((a, b) => b.fecha.getTime() - a.fecha.getTime())
    .at(0);
  return evt ? evt.fecha : installationDate;
}

function resolveVidaCostAndKm(params: {
  costos:           { valor: number; fecha: Date }[];
  inspecciones:     { fecha: Date; kilometrosEstimados: number | null }[];
  eventos:          { fecha: Date; notas: string | null }[];
  vidaActual:       VidaValue;
  currentKm:        number;
  installationDate: Date;
}): { costForVida: number; kmForVida: number } {
  const { costos, inspecciones, eventos, vidaActual, currentKm, installationDate } = params;

  const vidaStart = resolveVidaStartDate(eventos, vidaActual, installationDate);

  // Cost for this vida
  const vidaCostos = costos.filter(c => c.fecha >= vidaStart);
  let costForVida: number;
  if (vidaCostos.length > 0) {
    costForVida = vidaCostos.reduce((s, c) => s + c.valor, 0);
  } else {
    const sorted = [...costos].sort((a, b) => b.fecha.getTime() - a.fecha.getTime());
    costForVida = sorted.at(0)?.valor ?? 0;
  }

  // KM for this vida — FIXED: use last insp BEFORE vida start as baseline
  const allSorted = [...inspecciones].sort((a, b) => a.fecha.getTime() - b.fecha.getTime());
  const lastInspBeforeVida = [...allSorted]
    .reverse()
    .find(i => i.fecha < vidaStart);

  let kmAtVidaStart: number;
  if (lastInspBeforeVida?.kilometrosEstimados != null) {
    kmAtVidaStart = lastInspBeforeVida.kilometrosEstimados;
  } else if (vidaActual === VidaValue.nueva) {
    kmAtVidaStart = 0;
  } else {
    kmAtVidaStart = 0;
  }

  const kmForVida = Math.max(currentKm - kmAtVidaStart, 0);
  return { costForVida, kmForVida };
}

// ─── Tolerance for float comparison ─────────────────────────────────────────

function close(a: number | null, b: number, tol = 0.5): boolean {
  if (a == null) return b === 0;
  return Math.abs(a - b) <= tol;
}

function closePct(a: number | null, b: number, pct = 0.02): boolean {
  if (a == null) return b === 0;
  if (b === 0) return Math.abs(a) < 1;
  return Math.abs(a - b) / Math.max(Math.abs(b), 1) <= pct;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  TIREPRO INSPECTION AUDIT ${DRY_RUN ? '(DRY RUN — no writes)' : '(LIVE — will fix errors)'}`);
  console.log(`${'='.repeat(70)}\n`);

  const tires = await prisma.tire.findMany({
    include: {
      inspecciones: { orderBy: { fecha: 'asc' } },
      costos:       { orderBy: { fecha: 'asc' } },
      eventos:      { orderBy: { fecha: 'asc' } },
    },
  });

  console.log(`Loaded ${tires.length} tires.\n`);

  let totalInspections = 0;
  let totalErrors      = 0;
  let totalFixed       = 0;
  let tiresWithErrors  = 0;

  // Per-error-type counters
  const errorTypes: Record<string, number> = {
    cpk_wrong: 0,
    cpk_proyectado_wrong: 0,
    cpt_wrong: 0,
    cpt_proyectado_wrong: 0,
    km_proyectado_wrong: 0,
    km_decreasing: 0,
    km_missing: 0,
    depth_above_initial: 0,
    depth_negative: 0,
  };

  for (const tire of tires) {
    const insps = tire.inspecciones;
    if (!insps.length) continue;

    let tireHasError = false;
    const vidaActual = (tire.vidaActual as VidaValue) ?? VidaValue.nueva;
    const installDate = tire.fechaInstalacion ?? tire.createdAt;

    for (let idx = 0; idx < insps.length; idx++) {
      const insp = insps[idx];
      totalInspections++;

      const minDepth = calcMinDepth(
        insp.profundidadInt, insp.profundidadCen, insp.profundidadExt,
      );
      const avgDepth = (insp.profundidadInt + insp.profundidadCen + insp.profundidadExt) / 3;

      // ── Sanity checks ─────────────────────────────────────────────────

      // Depth above initial?
      if (avgDepth > tire.profundidadInicial + 1) {
        errorTypes.depth_above_initial++;
        if (!tireHasError) { tireHasError = true; tiresWithErrors++; }
      }

      // Negative depth?
      if (minDepth < 0) {
        errorTypes.depth_negative++;
        if (!tireHasError) { tireHasError = true; tiresWithErrors++; }
      }

      // KM decreasing from previous inspection?
      if (idx > 0) {
        const prevKm = insps[idx - 1].kilometrosEstimados ?? 0;
        const curKm  = insp.kilometrosEstimados ?? 0;
        if (curKm > 0 && prevKm > 0 && curKm < prevKm - 100) {
          errorTypes.km_decreasing++;
        }
      }

      // KM missing?
      if (insp.kilometrosEstimados == null || insp.kilometrosEstimados === 0) {
        errorTypes.km_missing++;
      }

      // ── Recompute correct metrics ──────────────────────────────────────

      // Get inspections BEFORE this one (what backend would have had)
      const priorInsps = insps.slice(0, idx);

      // Determine the vida at the time of this inspection
      const inspVida = insp.vidaAlMomento ?? vidaActual;

      // Current km is what was recorded for this inspection
      const currentKm = insp.kilometrosEstimados ?? insp.kmEfectivos ?? 0;

      const diasEnUso = insp.diasEnUso ?? 1;
      const mesesEnUso = insp.mesesEnUso ?? (diasEnUso / 30);

      // Resolve cost and km using the FIXED logic
      const { costForVida, kmForVida } = resolveVidaCostAndKm({
        costos:           tire.costos,
        inspecciones:     priorInsps,
        eventos:          tire.eventos,
        vidaActual:       inspVida as VidaValue,
        currentKm,
        installationDate: installDate,
      });

      const expected = calcCpkMetrics(
        costForVida,
        kmForVida,
        mesesEnUso,
        tire.profundidadInicial,
        minDepth,
      );

      // ── Compare stored vs expected ─────────────────────────────────────

      const errors: string[] = [];
      const updates: Record<string, number> = {};

      if (!closePct(insp.cpk, expected.cpk, 0.02)) {
        errors.push(`cpk: ${insp.cpk?.toFixed(2) ?? 'null'} → ${expected.cpk.toFixed(2)}`);
        errorTypes.cpk_wrong++;
        updates.cpk = Math.round(expected.cpk * 100) / 100;
      }

      if (!closePct(insp.cpkProyectado, expected.cpkProyectado, 0.05)) {
        errors.push(`cpkProy: ${insp.cpkProyectado?.toFixed(2) ?? 'null'} → ${expected.cpkProyectado.toFixed(2)}`);
        errorTypes.cpk_proyectado_wrong++;
        updates.cpkProyectado = Math.round(expected.cpkProyectado * 100) / 100;
      }

      if (!closePct(insp.cpt, expected.cpt, 0.02)) {
        errors.push(`cpt: ${insp.cpt?.toFixed(2) ?? 'null'} → ${expected.cpt.toFixed(2)}`);
        errorTypes.cpt_wrong++;
        updates.cpt = Math.round(expected.cpt * 100) / 100;
      }

      if (!closePct(insp.cptProyectado, expected.cptProyectado, 0.05)) {
        errors.push(`cptProy: ${insp.cptProyectado?.toFixed(2) ?? 'null'} → ${expected.cptProyectado.toFixed(2)}`);
        errorTypes.cpt_proyectado_wrong++;
        updates.cptProyectado = Math.round(expected.cptProyectado * 100) / 100;
      }

      if (!closePct(insp.kmProyectado, expected.projectedKm, 0.05)) {
        errors.push(`kmProy: ${insp.kmProyectado?.toFixed(0) ?? 'null'} → ${expected.projectedKm.toFixed(0)}`);
        errorTypes.km_proyectado_wrong++;
        updates.kmProyectado = Math.round(expected.projectedKm);
      }

      if (errors.length > 0) {
        totalErrors += errors.length;
        if (!tireHasError) { tireHasError = true; tiresWithErrors++; }

        console.log(
          `  TIRE ${tire.placa} | insp #${idx + 1} (${insp.fecha.toISOString().slice(0, 10)}) ` +
          `| km=${currentKm} depth=${minDepth.toFixed(1)}mm | ${errors.join(' | ')}`,
        );

        // Apply fix
        if (!DRY_RUN && Object.keys(updates).length > 0) {
          await prisma.inspeccion.update({
            where: { id: insp.id },
            data:  updates,
          });
          totalFixed += Object.keys(updates).length;
        }
      }
    }

    // ── Also refresh the tire's cached analytics columns ──────────────
    if (tireHasError && !DRY_RUN) {
      const lastInsp = insps[insps.length - 1];
      const minD = calcMinDepth(lastInsp.profundidadInt, lastInsp.profundidadCen, lastInsp.profundidadExt);
      const avgD = (lastInsp.profundidadInt + lastInsp.profundidadCen + lastInsp.profundidadExt) / 3;

      // Recompute the latest inspection's metrics
      const { costForVida, kmForVida } = resolveVidaCostAndKm({
        costos:           tire.costos,
        inspecciones:     insps.slice(0, -1),
        eventos:          tire.eventos,
        vidaActual,
        currentKm:        lastInsp.kilometrosEstimados ?? tire.kilometrosRecorridos ?? 0,
        installationDate: installDate,
      });

      const latestMetrics = calcCpkMetrics(
        costForVida,
        kmForVida,
        lastInsp.mesesEnUso ?? 1,
        tire.profundidadInicial,
        minD,
      );

      const projKmLeft = Math.max(latestMetrics.projectedKm - (tire.kilometrosRecorridos ?? 0), 0);

      await prisma.tire.update({
        where: { id: tire.id },
        data: {
          currentCpk:           Math.round(latestMetrics.cpk * 100) / 100,
          currentCpt:           Math.round(latestMetrics.cpt * 100) / 100,
          currentProfundidad:   Math.round(avgD * 10) / 10,
          projectedKmRemaining: projKmLeft > 0 ? Math.round(projKmLeft) : null,
          lastInspeccionDate:   lastInsp.fecha,
        },
      });
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  AUDIT SUMMARY`);
  console.log(`${'─'.repeat(70)}`);
  console.log(`  Tires scanned:        ${tires.length}`);
  console.log(`  Inspections scanned:  ${totalInspections}`);
  console.log(`  Tires with errors:    ${tiresWithErrors}`);
  console.log(`  Total errors found:   ${totalErrors}`);
  if (!DRY_RUN) {
    console.log(`  Values fixed:         ${totalFixed}`);
  }
  console.log();
  console.log(`  Error breakdown:`);
  for (const [type, count] of Object.entries(errorTypes)) {
    if (count > 0) console.log(`    ${type.padEnd(28)} ${count}`);
  }
  console.log(`${'─'.repeat(70)}\n`);

  if (DRY_RUN && totalErrors > 0) {
    console.log(`  Run without --dry-run to fix these errors.\n`);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
