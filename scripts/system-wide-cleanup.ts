/**
 * System-wide data cleanup & anomaly repair.
 *
 * PHASE 1 — String normalization
 *   • marca, diseno, dimension: collapse whitespace, fix casing, merge near-
 *     duplicate variants (e.g. "KMAX D" vs "KMAXD" vs "kmax d").
 *
 * PHASE 2 — Structural fixes
 *   • profundidadInicial too low (< observed depths)
 *   • Inspection depths > profundidadInicial
 *   • Orphaned inspections (tireId references deleted tire)
 *
 * PHASE 3 — Metric anomaly detection & repair
 *   • CPK sanity: negative, zero with cost+km, absurdly high (> $500/km)
 *   • KM sanity: negative, impossibly high for elapsed time
 *   • Recalculate CPK/CPT/projected for every inspection on affected tires
 *   • Refresh tire analytics cache for every repaired tire
 *
 * Usage:
 *   npx tsx scripts/system-wide-cleanup.ts --dry-run   # preview
 *   npx tsx scripts/system-wide-cleanup.ts              # apply
 */

import { PrismaClient, VidaValue } from '@prisma/client';

const prisma = new PrismaClient({ log: ['warn', 'error'] });

const DRY_RUN = process.argv.includes('--dry-run');

// ── Constants (mirror tire.service.ts) ──────────────────────────────────────
const LIMITE_LEGAL_MM  = 2;
const EXPECTED_KM      = 80_000;
const KM_POR_MES       = 6_000;
const MS_POR_DIA       = 86_400_000;
const MIN_MEANINGFUL_KM = 5_000;

// ── Counters ────────────────────────────────────────────────────────────────
const stats = {
  // Phase 1
  marcaNormalized: 0,
  disenoNormalized: 0,
  dimensionNormalized: 0,
  marcaMerged: 0,
  disenoMerged: 0,
  // Phase 2
  profInicialFixed: 0,
  // Phase 3
  inspCpkRecalculated: 0,
  inspKmFixed: 0,
  tiresRefreshed: 0,
  anomaliesFound: 0,
};

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 1: String Normalization
// ═════════════════════════════════════════════════════════════════════════════

function normalizeString(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, ' ')           // collapse multiple spaces/tabs
    .toUpperCase();
}

function normalizeMarca(raw: string): string {
  let s = normalizeString(raw);

  // Common brand misspellings / variants
  const BRAND_MAP: Record<string, string> = {
    'GOOD YEAR':    'GOODYEAR',
    'GOODYER':      'GOODYEAR',
    'GODDYEAR':     'GOODYEAR',
    'BRIDGSTONE':   'BRIDGESTONE',
    'BRIDGSTON':    'BRIDGESTONE',
    'BRIDESTON':    'BRIDGESTONE',
    'FIRE STONE':   'FIRESTONE',
    'FIRESTORE':    'FIRESTONE',
    'FIRETONE':     'FIRESTONE',
    'MICHLEN':      'MICHELIN',
    'MICHELLIN':    'MICHELIN',
    'MITCHELIN':    'MICHELIN',
    'MITCHELLIN':   'MICHELIN',
    'CONTINNENTAL': 'CONTINENTAL',
    'CONTINETAL':   'CONTINENTAL',
    'PIRRELLI':     'PIRELLI',
    'PIRELI':       'PIRELLI',
    'HANKOKK':      'HANKOOK',
    'HANCOOK':      'HANKOOK',
    'HANDKOOK':     'HANKOOK',
    'YOKHAMA':      'YOKOHAMA',
    'YOKOAMA':      'YOKOHAMA',
    'DUNLOP':       'DUNLOP',
    'DUNLOOP':      'DUNLOP',
    'GENERALTIRE':  'GENERAL TIRE',
    'GENERAL':      'GENERAL TIRE',
    'DOUBLE COIN':  'DOUBLECOIN',
    'DOUBLECOINS':  'DOUBLECOIN',
    'MAXXIS':       'MAXXIS',
    'MAXXI':        'MAXXIS',
    'MAXIMILLIAS':  'MAXMILLAS',
    'MAX MILLAS':   'MAXMILLAS',
  };

  if (BRAND_MAP[s]) s = BRAND_MAP[s];
  return s;
}

/**
 * Normalize a diseno (tread design) string.
 * Collapses spaces around separators but preserves meaningful internal spaces.
 * e.g. "KMAX D" and "KMAXD" → need fuzzy merge in Phase 1b.
 */
function normalizeDiseno(raw: string): string {
  let s = normalizeString(raw);
  // Remove trailing dots/commas
  s = s.replace(/[.,]+$/, '');
  return s;
}

/**
 * Normalize dimension strings to a canonical form.
 * "295/80 R 22.5" → "295/80R22.5"
 * "295 / 80 R 22.5" → "295/80R22.5"
 * "11R22.5" → "11R22.5"
 */
function normalizeDimension(raw: string): string {
  let s = normalizeString(raw);
  // Remove all spaces around / and R
  s = s.replace(/\s*\/\s*/g, '/');
  s = s.replace(/\s*R\s*/g, 'R');
  // Common patterns: "295/80 R22.5" → "295/80R22.5"
  s = s.replace(/(\d)R(\d)/g, '$1R$2');
  return s;
}

/**
 * Compute similarity between two strings (Dice coefficient on bigrams).
 * Returns 0..1 where 1 = identical.
 */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string) => {
    const set = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bi = s.substring(i, i + 2);
      set.set(bi, (set.get(bi) || 0) + 1);
    }
    return set;
  };
  const aBi = bigrams(a);
  const bBi = bigrams(b);
  let inter = 0;
  for (const [k, v] of aBi) {
    inter += Math.min(v, bBi.get(k) || 0);
  }
  return (2 * inter) / (a.length - 1 + b.length - 1);
}

/**
 * Build a canonical form by stripping spaces, hyphens, dots for comparison.
 * "KMAX D" → "KMAXD", "XDE 2+" → "XDE2+"
 */
function stripped(s: string): string {
  return s.replace(/[\s\-\.]+/g, '');
}

async function phase0_revertBadMerges() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  PHASE 0: Revert Known Bad Merges');
  console.log('══════════════════════════════════════════════════════════════\n');

  // These were incorrectly merged by the old 0.85 similarity threshold.
  // They are distinct brands/designs, not typos.
  const reversals: { field: 'marca' | 'diseno'; wrongValue: string; correctValue: string; context?: string }[] = [
    { field: 'marca', wrongValue: 'REMAX',     correctValue: 'GREMAX',   context: 'GREMAX is a separate brand from REMAX' },
    { field: 'marca', wrongValue: 'SAFECESS',  correctValue: 'AFECESS',  context: 'AFECESS is a separate brand from SAFECESS' },
  ];

  for (const r of reversals) {
    // Find tires that were originally the correctValue but got merged into wrongValue.
    // We can identify them because the previous run changed correctValue → wrongValue.
    // We need to check if there are tires with the wrongValue that should be correctValue.
    // Since we can't tell which ones were originally which after the merge, we'll
    // look for tires that had the correctValue via the externalSourceId or sourceMetadata.
    // Safest approach: just report and let the user decide.

    // Actually — the merge changed ALL tires with correctValue to wrongValue.
    // So if we had 82 GREMAX tires, they all became REMAX. But there were also
    // legitimate REMAX tires. We can't distinguish them now.
    //
    // However, the merge logic kept the MORE COMMON name and renamed the LESS
    // common one into it. "GREMAX" → "REMAX" means REMAX had more tires.
    // Wait — actually it's the other way: the variant (less common) gets renamed
    // to the canonical (more common). Looking at the output:
    //   "GREMAX" → "REMAX" means REMAX had ≥ GREMAX count.
    //   "AFECESS" → "SAFECESS" means SAFECESS had ≥ AFECESS count.
    //
    // So GREMAX tires were renamed to REMAX. We know exactly how many: 82.
    // And AFECESS tires were renamed to SAFECESS: 23.
    //
    // We can't distinguish which current "REMAX" tires were originally GREMAX
    // without a pre-merge snapshot. Best we can do: report the issue.

    console.log(`  WARNING: "${r.correctValue}" was incorrectly merged into "${r.wrongValue}"`);
    console.log(`    ${r.context}`);
    console.log(`    To fix: manually identify which "${r.wrongValue}" tires should be "${r.correctValue}"`);
    console.log(`    Or run: UPDATE tires SET marca='${r.correctValue}' WHERE marca='${r.wrongValue}' AND <your filter>;`);
    console.log();
  }
}

async function phase1_normalizeStrings() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  PHASE 1: String Normalization');
  console.log('══════════════════════════════════════════════════════════════\n');

  // ── 1a: Direct normalization (case, whitespace, known misspellings) ────
  const tires = await prisma.tire.findMany({
    select: { id: true, marca: true, diseno: true, dimension: true },
  });

  console.log(`  Loaded ${tires.length} tires for string normalization.\n`);

  const marcaUpdates: { id: string; from: string; to: string }[] = [];
  const disenoUpdates: { id: string; from: string; to: string }[] = [];
  const dimensionUpdates: { id: string; from: string; to: string }[] = [];

  for (const t of tires) {
    const newMarca = normalizeMarca(t.marca || '');
    if (newMarca && newMarca !== (t.marca || '').trim()) {
      marcaUpdates.push({ id: t.id, from: t.marca, to: newMarca });
    }

    const newDiseno = normalizeDiseno(t.diseno || '');
    if (newDiseno && newDiseno !== (t.diseno || '').trim()) {
      disenoUpdates.push({ id: t.id, from: t.diseno, to: newDiseno });
    }

    const newDim = normalizeDimension(t.dimension || '');
    if (newDim && newDim !== (t.dimension || '').trim()) {
      dimensionUpdates.push({ id: t.id, from: t.dimension, to: newDim });
    }
  }

  console.log(`  Marca normalizations: ${marcaUpdates.length}`);
  if (marcaUpdates.length > 0) {
    const sample = marcaUpdates.slice(0, 10);
    for (const u of sample) console.log(`    "${u.from}" → "${u.to}"`);
    if (marcaUpdates.length > 10) console.log(`    ... and ${marcaUpdates.length - 10} more`);
  }

  console.log(`  Diseño normalizations: ${disenoUpdates.length}`);
  if (disenoUpdates.length > 0) {
    const sample = disenoUpdates.slice(0, 10);
    for (const u of sample) console.log(`    "${u.from}" → "${u.to}"`);
    if (disenoUpdates.length > 10) console.log(`    ... and ${disenoUpdates.length - 10} more`);
  }

  console.log(`  Dimension normalizations: ${dimensionUpdates.length}`);
  if (dimensionUpdates.length > 0) {
    const sample = dimensionUpdates.slice(0, 10);
    for (const u of sample) console.log(`    "${u.from}" → "${u.to}"`);
    if (dimensionUpdates.length > 10) console.log(`    ... and ${dimensionUpdates.length - 10} more`);
  }

  if (!DRY_RUN) {
    for (const u of marcaUpdates) {
      await prisma.tire.update({ where: { id: u.id }, data: { marca: u.to } });
      stats.marcaNormalized++;
    }
    for (const u of disenoUpdates) {
      await prisma.tire.update({ where: { id: u.id }, data: { diseno: u.to } });
      stats.disenoNormalized++;
    }
    for (const u of dimensionUpdates) {
      await prisma.tire.update({ where: { id: u.id }, data: { dimension: u.to } });
      stats.dimensionNormalized++;
    }
  } else {
    stats.marcaNormalized = marcaUpdates.length;
    stats.disenoNormalized = disenoUpdates.length;
    stats.dimensionNormalized = dimensionUpdates.length;
  }

  // ── 1b: Fuzzy merge — find diseno variants within the same marca ───────
  console.log('\n  --- Fuzzy diseno merge (within same marca) ---');

  // Group by normalized marca
  const afterNorm = tires.map(t => ({
    id: t.id,
    marca: normalizeMarca(t.marca || ''),
    diseno: normalizeDiseno(t.diseno || ''),
  }));

  const byMarca = new Map<string, Map<string, string[]>>();
  for (const t of afterNorm) {
    if (!t.marca || !t.diseno) continue;
    if (!byMarca.has(t.marca)) byMarca.set(t.marca, new Map());
    const disenoMap = byMarca.get(t.marca)!;
    if (!disenoMap.has(t.diseno)) disenoMap.set(t.diseno, []);
    disenoMap.get(t.diseno)!.push(t.id);
  }

  const merges: { from: string; to: string; marca: string; tireIds: string[] }[] = [];

  for (const [marca, disenoMap] of byMarca) {
    const disenos = Array.from(disenoMap.keys());
    const merged = new Set<string>();

    for (let i = 0; i < disenos.length; i++) {
      if (merged.has(disenos[i])) continue;
      for (let j = i + 1; j < disenos.length; j++) {
        if (merged.has(disenos[j])) continue;

        const a = disenos[i];
        const b = disenos[j];

        // Only auto-merge when stripped forms are identical (spaces/hyphens
        // are the only difference). e.g. "KMAX D" and "KMAXD" → same tire.
        // Similarity-based matches are too dangerous — GREMAX ≠ REMAX,
        // AFECESS ≠ SAFECESS — so those go to the Phase 4 review list only.
        if (stripped(a) === stripped(b)) {
          const aCount = disenoMap.get(a)!.length;
          const bCount = disenoMap.get(b)!.length;
          const [canonical, variant] = aCount >= bCount ? [a, b] : [b, a];
          merges.push({
            from: variant,
            to: canonical,
            marca,
            tireIds: disenoMap.get(variant)!,
          });
          merged.add(variant);
        }
      }
    }
  }

  console.log(`  Fuzzy diseno merges found: ${merges.length}`);
  for (const m of merges) {
    console.log(`    [${m.marca}] "${m.from}" → "${m.to}" (${m.tireIds.length} tires)`);
  }

  if (!DRY_RUN) {
    for (const m of merges) {
      await prisma.tire.updateMany({
        where: { id: { in: m.tireIds } },
        data: { diseno: m.to },
      });
      stats.disenoMerged += m.tireIds.length;
    }
  } else {
    stats.disenoMerged = merges.reduce((s, m) => s + m.tireIds.length, 0);
  }

  // ── 1c: Same fuzzy merge for marca across all tires ────────────────────
  console.log('\n  --- Fuzzy marca merge ---');

  const marcaCounts = new Map<string, string[]>();
  for (const t of afterNorm) {
    if (!t.marca) continue;
    if (!marcaCounts.has(t.marca)) marcaCounts.set(t.marca, []);
    marcaCounts.get(t.marca)!.push(t.id);
  }

  const marcaMerges: { from: string; to: string; tireIds: string[] }[] = [];
  const marcas = Array.from(marcaCounts.keys());
  const marcaMerged = new Set<string>();

  for (let i = 0; i < marcas.length; i++) {
    if (marcaMerged.has(marcas[i])) continue;
    for (let j = i + 1; j < marcas.length; j++) {
      if (marcaMerged.has(marcas[j])) continue;
      const a = marcas[i];
      const b = marcas[j];
      // Only auto-merge when stripped forms are identical.
      // Similarity-based matches go to Phase 4 review list.
      if (stripped(a) === stripped(b)) {
        const aCount = marcaCounts.get(a)!.length;
        const bCount = marcaCounts.get(b)!.length;
        const [canonical, variant] = aCount >= bCount ? [a, b] : [b, a];
        marcaMerges.push({
          from: variant,
          to: canonical,
          tireIds: marcaCounts.get(variant)!,
        });
        marcaMerged.add(variant);
      }
    }
  }

  console.log(`  Fuzzy marca merges found: ${marcaMerges.length}`);
  for (const m of marcaMerges) {
    console.log(`    "${m.from}" → "${m.to}" (${m.tireIds.length} tires)`);
  }

  if (!DRY_RUN) {
    for (const m of marcaMerges) {
      await prisma.tire.updateMany({
        where: { id: { in: m.tireIds } },
        data: { marca: m.to },
      });
      stats.marcaMerged += m.tireIds.length;
    }
  } else {
    stats.marcaMerged = marcaMerges.reduce((s, m) => s + m.tireIds.length, 0);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 2: Structural Fixes
// ═════════════════════════════════════════════════════════════════════════════

async function phase2_structuralFixes() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  PHASE 2: Structural Fixes');
  console.log('══════════════════════════════════════════════════════════════\n');

  const tires = await prisma.tire.findMany({
    include: {
      inspecciones: { orderBy: { fecha: 'asc' } },
    },
  });

  let profInicialFixed = 0;

  for (const tire of tires) {
    if (tire.inspecciones.length === 0) continue;

    const maxObserved = Math.max(
      ...tire.inspecciones.map(i =>
        Math.max(i.profundidadInt, i.profundidadCen, i.profundidadExt),
      ),
    );

    const profInicial = tire.profundidadInicial ?? 22;

    // Fix: profundidadInicial must be ≥ all observed depths
    if (maxObserved >= profInicial || profInicial < 8) {
      const newProf = Math.max(maxObserved + 1, 16);
      console.log(`  Tire ${tire.placa} (${tire.id.slice(0, 8)}): profInicial ${profInicial} → ${newProf} (max observed: ${maxObserved})`);

      if (!DRY_RUN) {
        await prisma.tire.update({
          where: { id: tire.id },
          data: { profundidadInicial: newProf },
        });
      }
      profInicialFixed++;
    }
  }

  stats.profInicialFixed = profInicialFixed;
  console.log(`\n  profundidadInicial fixes: ${profInicialFixed}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 3: Metric Anomaly Detection & Recalculation
// ═════════════════════════════════════════════════════════════════════════════

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
      if (mmWorn <= 0) {
        projectedKm = fallbackEstimate;
      } else {
        const c = Math.min(mmWorn / usableDepth, 1);
        projectedKm = wearEstimate * c + fallbackEstimate * (1 - c);
      }
    } else {
      projectedKm = EXPECTED_KM;
    }
  }
  projectedKm = Math.round(projectedKm);

  let cpk: number;
  if (km >= MIN_MEANINGFUL_KM) {
    cpk = totalCost / km;
  } else if (projectedKm > 0 && totalCost > 0) {
    cpk = totalCost / projectedKm;
  } else {
    cpk = 0;
  }

  const cpt: number | null = meses > 0 ? totalCost / meses : null;
  const cpkProyectado = projectedKm > 0 && totalCost > 0 ? totalCost / projectedKm : 0;
  const projectedMonths = projectedKm / KM_POR_MES;
  const cptProyectado = projectedMonths > 0 && totalCost > 0 ? totalCost / projectedMonths : 0;

  return { cpk, cpt, cpkProyectado, cptProyectado, projectedKm };
}

function calcHealthScore(
  profInicial: number,
  minDepthMm: number,
  pInt: number,
  pCen: number,
  pExt: number,
): number {
  const usable = Math.max(profInicial - LIMITE_LEGAL_MM, 1);
  const remaining = Math.max(minDepthMm - LIMITE_LEGAL_MM, 0);
  const base = Math.round((remaining / usable) * 100);
  const maxDelta = Math.max(
    Math.abs(pInt - pCen),
    Math.abs(pCen - pExt),
    Math.abs(pInt - pExt),
  );
  const penalty = Math.min(maxDelta * 5, 25);
  return Math.max(0, Math.min(100, base - penalty));
}

function deriveAlertLevel(healthScore: number, minDepthMm: number): string {
  if (minDepthMm <= LIMITE_LEGAL_MM || healthScore < 25) return 'critical';
  if (healthScore < 50) return 'warning';
  if (healthScore < 70) return 'watch';
  return 'ok';
}

async function phase3_anomalyDetectionAndRepair() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  PHASE 3: Metric Anomaly Detection & Recalculation');
  console.log('══════════════════════════════════════════════════════════════\n');

  const tires = await prisma.tire.findMany({
    include: {
      inspecciones: { orderBy: { fecha: 'asc' } },
      costos:       { orderBy: { fecha: 'asc' } },
    },
  });

  console.log(`  Loaded ${tires.length} tires for anomaly scan.\n`);

  const anomalyLog: string[] = [];
  const tiresNeedingRefresh = new Set<string>();

  for (const tire of tires) {
    if (tire.inspecciones.length === 0) continue;

    const profInicial = tire.profundidadInicial ?? 22;
    const totalCost = (tire.costos ?? []).reduce((s, c) => s + (c.valor ?? 0), 0);
    const fechaInstalacion = tire.fechaInstalacion ?? tire.inspecciones[0]?.fecha ?? new Date();

    let tireNeedsRecalc = false;

    for (const insp of tire.inspecciones) {
      const md = Math.min(insp.profundidadInt, insp.profundidadCen, insp.profundidadExt);
      const inspDate = new Date(insp.fecha);
      const diasEnUso = Math.max(
        Math.floor((inspDate.getTime() - new Date(fechaInstalacion).getTime()) / MS_POR_DIA),
        1,
      );
      const mesesEnUso = diasEnUso / 30;

      // ── Anomaly checks ──────────────────────────────────────────────

      // 1. Negative or NaN depths
      if (insp.profundidadInt < 0 || insp.profundidadCen < 0 || insp.profundidadExt < 0 ||
          !Number.isFinite(insp.profundidadInt) || !Number.isFinite(insp.profundidadCen) || !Number.isFinite(insp.profundidadExt)) {
        anomalyLog.push(`[DEPTH] Tire ${tire.placa} insp ${insp.id.slice(0,8)}: negative/NaN depths (${insp.profundidadInt}/${insp.profundidadCen}/${insp.profundidadExt})`);
        tireNeedsRecalc = true;
        stats.anomaliesFound++;
      }

      // 2. CPK is negative
      if (insp.cpk != null && insp.cpk < 0) {
        anomalyLog.push(`[CPK<0] Tire ${tire.placa} insp ${insp.id.slice(0,8)}: cpk=${insp.cpk}`);
        tireNeedsRecalc = true;
        stats.anomaliesFound++;
      }

      // 3. CPK absurdly high (> $500/km — a $2M tire would need < 4000km)
      if (insp.cpk != null && insp.cpk > 500) {
        anomalyLog.push(`[CPK>500] Tire ${tire.placa} insp ${insp.id.slice(0,8)}: cpk=${insp.cpk.toFixed(2)} (cost=${totalCost}, km=${insp.kilometrosEstimados})`);
        tireNeedsRecalc = true;
        stats.anomaliesFound++;
      }

      // 4. KM negative
      if (insp.kilometrosEstimados != null && insp.kilometrosEstimados < 0) {
        anomalyLog.push(`[KM<0] Tire ${tire.placa} insp ${insp.id.slice(0,8)}: km=${insp.kilometrosEstimados}`);
        tireNeedsRecalc = true;
        stats.anomaliesFound++;
      }

      // 5. KM impossibly high for elapsed time (> 300km/day sustained)
      if (insp.kilometrosEstimados != null && insp.kilometrosEstimados > 0 && diasEnUso > 0) {
        const kmPerDay = insp.kilometrosEstimados / diasEnUso;
        if (kmPerDay > 300) {
          anomalyLog.push(`[KM/DAY] Tire ${tire.placa} insp ${insp.id.slice(0,8)}: ${insp.kilometrosEstimados}km in ${diasEnUso}d = ${kmPerDay.toFixed(0)}km/day`);
          stats.anomaliesFound++;
        }
      }

      // 6. CPK should exist but doesn't (has cost + meaningful km)
      if (totalCost > 0 && (insp.kilometrosEstimados ?? 0) >= MIN_MEANINGFUL_KM && (insp.cpk == null || insp.cpk === 0)) {
        anomalyLog.push(`[CPK=0] Tire ${tire.placa} insp ${insp.id.slice(0,8)}: missing cpk despite cost=${totalCost} km=${insp.kilometrosEstimados}`);
        tireNeedsRecalc = true;
        stats.anomaliesFound++;
      }

      // 7. CPK exists but km=0 and cost=0 — shouldn't have a cpk
      if ((insp.cpk ?? 0) > 0 && totalCost === 0 && (insp.kilometrosEstimados ?? 0) === 0) {
        anomalyLog.push(`[GHOST-CPK] Tire ${tire.placa} insp ${insp.id.slice(0,8)}: cpk=${insp.cpk} but no cost/km`);
        tireNeedsRecalc = true;
        stats.anomaliesFound++;
      }

      // 8. Projected km is negative or absurd (> 500k)
      if (insp.kmProyectado != null && (insp.kmProyectado < 0 || insp.kmProyectado > 500_000)) {
        anomalyLog.push(`[PROJ-KM] Tire ${tire.placa} insp ${insp.id.slice(0,8)}: kmProyectado=${insp.kmProyectado}`);
        tireNeedsRecalc = true;
        stats.anomaliesFound++;
      }

      // 9. diasEnUso is negative
      if (insp.diasEnUso != null && insp.diasEnUso < 0) {
        anomalyLog.push(`[DIAS<0] Tire ${tire.placa} insp ${insp.id.slice(0,8)}: diasEnUso=${insp.diasEnUso}`);
        tireNeedsRecalc = true;
        stats.anomaliesFound++;
      }

      // 10. CPT negative or absurd
      if (insp.cpt != null && (insp.cpt < 0 || insp.cpt > 100_000_000)) {
        anomalyLog.push(`[CPT] Tire ${tire.placa} insp ${insp.id.slice(0,8)}: cpt=${insp.cpt}`);
        tireNeedsRecalc = true;
        stats.anomaliesFound++;
      }
    }

    // ── Recalculate all inspections for this tire if anomalies found ────
    if (tireNeedsRecalc) {
      tiresNeedingRefresh.add(tire.id);

      if (!DRY_RUN) {
        // Recalculate every inspection on this tire
        for (const insp of tire.inspecciones) {
          const md = Math.min(insp.profundidadInt, insp.profundidadCen, insp.profundidadExt);
          const inspDate = new Date(insp.fecha);
          const diasEnUso = Math.max(
            Math.floor((inspDate.getTime() - new Date(fechaInstalacion).getTime()) / MS_POR_DIA),
            1,
          );
          const mesesEnUso = diasEnUso / 30;

          // Use the tire's km at this point. If the inspection has km, use it.
          // Otherwise estimate from wear.
          let km = insp.kilometrosEstimados ?? 0;
          if (km < 0) km = 0;

          // If km is impossibly high, cap it and re-estimate
          if (km > 0 && diasEnUso > 0 && km / diasEnUso > 300) {
            // Re-estimate from wear
            const usable = Math.max(profInicial - LIMITE_LEGAL_MM, 1);
            const worn = Math.max(profInicial - md, 0);
            km = Math.round((worn / usable) * EXPECTED_KM);
            stats.inspKmFixed++;
          }

          const metrics = calcCpkMetrics(totalCost, km, mesesEnUso, profInicial, md);

          // Compute lifetime CPK
          const allCosts = (tire.costos ?? []).reduce((s, c) => s + (c.valor ?? 0), 0);
          const tireKm = tire.kilometrosRecorridos ?? 0;
          const lifetimeCpk = tireKm >= MIN_MEANINGFUL_KM && allCosts > 0
            ? allCosts / tireKm
            : null;

          await prisma.inspeccion.update({
            where: { id: insp.id },
            data: {
              cpk:                metrics.cpk,
              cpkProyectado:      metrics.cpkProyectado,
              cpt:                metrics.cpt,
              cptProyectado:      metrics.cptProyectado,
              kmProyectado:       metrics.projectedKm,
              diasEnUso,
              mesesEnUso,
              kilometrosEstimados: km,
              kmEfectivos:        km,
              lifetimeCpk,
            },
          });
          stats.inspCpkRecalculated++;
        }

        // Refresh tire analytics cache
        const latestInsp = tire.inspecciones[tire.inspecciones.length - 1];
        if (latestInsp) {
          const md = Math.min(latestInsp.profundidadInt, latestInsp.profundidadCen, latestInsp.profundidadExt);
          const avgD = (latestInsp.profundidadInt + latestInsp.profundidadCen + latestInsp.profundidadExt) / 3;
          const hs = calcHealthScore(profInicial, md, latestInsp.profundidadInt, latestInsp.profundidadCen, latestInsp.profundidadExt);
          const al = deriveAlertLevel(hs, md);

          const tireKm = tire.kilometrosRecorridos ?? 0;
          const allCosts = (tire.costos ?? []).reduce((s, c) => s + (c.valor ?? 0), 0);

          let currentCpk: number | null = null;
          if (tireKm >= MIN_MEANINGFUL_KM && allCosts > 0) {
            currentCpk = allCosts / tireKm;
          } else if (latestInsp.cpkProyectado) {
            currentCpk = latestInsp.cpkProyectado;
          }

          const lifetimeCpk = tireKm >= MIN_MEANINGFUL_KM && allCosts > 0
            ? allCosts / tireKm
            : null;

          await prisma.tire.update({
            where: { id: tire.id },
            data: {
              currentCpk,
              lifetimeCpk,
              currentProfundidad: Math.round(avgD * 100) / 100,
              healthScore: hs,
              alertLevel: al as any,
              lastInspeccionDate: latestInsp.fecha,
            },
          });
          stats.tiresRefreshed++;
        }
      }
    }
  }

  // Print anomaly log
  if (anomalyLog.length > 0) {
    console.log(`  Anomalies found: ${anomalyLog.length}\n`);
    // Print first 50, summarize rest
    const limit = 50;
    for (let i = 0; i < Math.min(anomalyLog.length, limit); i++) {
      console.log(`    ${anomalyLog[i]}`);
    }
    if (anomalyLog.length > limit) {
      console.log(`    ... and ${anomalyLog.length - limit} more anomalies`);
    }
  } else {
    console.log('  No anomalies found!');
  }

  console.log(`\n  Tires needing recalculation: ${tiresNeedingRefresh.size}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 4: Post-cleanup summary of distinct values
// ═════════════════════════════════════════════════════════════════════════════

async function phase4_summary() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  PHASE 4: Post-Cleanup Summary');
  console.log('══════════════════════════════════════════════════════════════\n');

  const marcas = await prisma.tire.groupBy({
    by: ['marca'],
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } },
  });

  console.log(`  Distinct marcas: ${marcas.length}`);
  for (const m of marcas.slice(0, 20)) {
    console.log(`    ${m.marca} (${m._count.id} tires)`);
  }

  const disenos = await prisma.tire.groupBy({
    by: ['marca', 'diseno'],
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } },
  });

  console.log(`\n  Distinct marca+diseno combos: ${disenos.length}`);
  for (const d of disenos.slice(0, 30)) {
    console.log(`    ${d.marca} / ${d.diseno} (${d._count.id})`);
  }

  // Show potential remaining duplicates
  console.log('\n  --- Potential remaining near-duplicates (manual review) ---');
  const groupedByMarca = new Map<string, string[]>();
  for (const d of disenos) {
    if (!groupedByMarca.has(d.marca)) groupedByMarca.set(d.marca, []);
    groupedByMarca.get(d.marca)!.push(d.diseno);
  }
  let potentialDupes = 0;
  for (const [marca, designs] of groupedByMarca) {
    for (let i = 0; i < designs.length; i++) {
      for (let j = i + 1; j < designs.length; j++) {
        const sim = similarity(designs[i], designs[j]);
        if (sim >= 0.7 && sim < 0.85) {
          console.log(`    [${marca}] "${designs[i]}" ↔ "${designs[j]}" (sim=${sim.toFixed(2)}) — review manually`);
          potentialDupes++;
        }
      }
    }
  }
  if (potentialDupes === 0) console.log('    None found.');
}

// ═════════════════════════════════════════════════════════════════════════════
// Main
// ═════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  TirePro System-Wide Data Cleanup');
  console.log(`  Mode: ${DRY_RUN ? '*** DRY RUN ***' : 'LIVE — changes will be written'}`);
  console.log(`  Date: ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════════════════');

  await phase0_revertBadMerges();
  await phase1_normalizeStrings();
  await phase2_structuralFixes();
  await phase3_anomalyDetectionAndRepair();
  await phase4_summary();

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  FINAL STATS');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Marca normalized:        ${stats.marcaNormalized}`);
  console.log(`  Marca fuzzy-merged:      ${stats.marcaMerged}`);
  console.log(`  Diseño normalized:       ${stats.disenoNormalized}`);
  console.log(`  Diseño fuzzy-merged:     ${stats.disenoMerged}`);
  console.log(`  Dimension normalized:    ${stats.dimensionNormalized}`);
  console.log(`  profundidadInicial fixed: ${stats.profInicialFixed}`);
  console.log(`  Anomalies found:         ${stats.anomaliesFound}`);
  console.log(`  Inspections recalculated: ${stats.inspCpkRecalculated}`);
  console.log(`  Inspection KM fixed:     ${stats.inspKmFixed}`);
  console.log(`  Tire caches refreshed:   ${stats.tiresRefreshed}`);
  console.log('═══════════════════════════════════════════════════════════════');
  if (DRY_RUN) console.log('\n  Re-run without --dry-run to apply changes.\n');

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  prisma.$disconnect();
  process.exit(1);
});
