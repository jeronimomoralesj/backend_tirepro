/**
 * Backfills the "dinero perdido" value on every fin-de-vida record so that
 * existing data lines up with the new formula used by updateVida:
 *
 *   dineroPerdido = mm_remaining × (costo_vida / profundidad_inicial_vida)
 *
 * Updates two stores:
 *   1. TireVidaSnapshot.desechoRemanente — canonical, used by new analytics.
 *   2. Tire.desechos (legacy JSON) — still read by /dashboard/desechos.
 *      Rewrites remanente to raw mm (what the frontend expects) and adds
 *      dineroPerdido as the canonical COP value.
 *
 * Usage:
 *   DATABASE_URL=... npx ts-node scripts/backfill-dinero-perdido.ts [--apply]
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

function compute(mmRemaining: number, costoVida: number, profundidadInicial: number): number | null {
  if (!mmRemaining || mmRemaining <= 0) return 0;
  if (!costoVida || costoVida <= 0) return null;
  if (!profundidadInicial || profundidadInicial <= 0) return null;
  return parseFloat(((costoVida / profundidadInicial) * mmRemaining).toFixed(2));
}

async function main() {
  // ── 1. Snapshots ─────────────────────────────────────────────────────────
  const snaps = await prisma.tireVidaSnapshot.findMany({
    where: { desechoMilimetros: { not: null, gt: 0 } },
    select: {
      id: true,
      tireId: true,
      costoInicial: true,
      profundidadInicial: true,
      desechoMilimetros: true,
      desechoRemanente: true,
    },
  });

  let snapUpdated = 0;
  let snapUnchanged = 0;
  let snapUncomputable = 0;
  const preview: Array<{ id: string; before: number | null; after: number | null; inputs: string }> = [];

  for (const s of snaps) {
    const next = compute(s.desechoMilimetros!, s.costoInicial, s.profundidadInicial);
    if (next == null) { snapUncomputable++; continue; }
    const roundedCurrent = s.desechoRemanente != null ? Math.round(s.desechoRemanente * 100) / 100 : null;
    if (roundedCurrent === next) { snapUnchanged++; continue; }
    snapUpdated++;
    if (preview.length < 10) {
      preview.push({
        id: s.id,
        before: s.desechoRemanente,
        after: next,
        inputs: `mm=${s.desechoMilimetros}, costo=${s.costoInicial}, rtd=${s.profundidadInicial}`,
      });
    }
    if (APPLY) {
      await prisma.tireVidaSnapshot.update({
        where: { id: s.id },
        data: { desechoRemanente: next },
      });
    }
  }

  // ── 2. Legacy Tire.desechos JSON on tires currently in 'fin' ────────────
  const finTires = await prisma.tire.findMany({
    where: { vidaActual: 'fin' },
    select: {
      id: true,
      placa: true,
      profundidadInicial: true,
      desechos: true,
      costos: {
        select: { valor: true, concepto: true, fecha: true },
        orderBy: { fecha: 'asc' },
      },
      vidaSnapshots: {
        where: { desechoMilimetros: { not: null, gt: 0 } },
        orderBy: { fechaFin: 'desc' },
        take: 1,
        select: { costoInicial: true, profundidadInicial: true, desechoMilimetros: true, desechoRemanente: true },
      },
    },
  });

  let legacyUpdated = 0;
  let legacyUnchanged = 0;
  let legacySkipped = 0;
  const legacyPreview: Array<{ placa: string; remanenteBefore: any; remanenteAfter: number; dineroPerdido: number | null }> = [];

  for (const t of finTires) {
    const d = t.desechos as any;
    if (!d || typeof d !== 'object') { legacySkipped++; continue; }

    // Prefer the finalized snapshot we just fixed; otherwise fall back to
    // the mm stored on the legacy JSON and the latest tire cost.
    const snap = t.vidaSnapshots[0];
    const mmRemaining = snap?.desechoMilimetros
      ?? Number(d.milimetrosDesechados)
      ?? null;
    const costoVida = snap?.costoInicial
      ?? t.costos.at(-1)?.valor
      ?? null;
    const rtdInicial = snap?.profundidadInicial
      ?? t.profundidadInicial;

    if (!mmRemaining || !costoVida || !rtdInicial) { legacySkipped++; continue; }

    const dineroPerdido = compute(mmRemaining, costoVida, rtdInicial);
    const nextRemanente = mmRemaining; // mm (aligns with frontend comment)

    const alreadyCorrect =
      Math.round((d.remanente ?? -1) * 100) / 100 === Math.round(nextRemanente * 100) / 100 &&
      Math.round((d.dineroPerdido ?? -1) * 100) / 100 === (dineroPerdido != null ? Math.round(dineroPerdido * 100) / 100 : -1);
    if (alreadyCorrect) { legacyUnchanged++; continue; }

    legacyUpdated++;
    if (legacyPreview.length < 10) {
      legacyPreview.push({
        placa: t.placa,
        remanenteBefore: d.remanente,
        remanenteAfter: nextRemanente,
        dineroPerdido,
      });
    }

    if (APPLY) {
      await prisma.tire.update({
        where: { id: t.id },
        data: {
          desechos: {
            ...d,
            remanente: nextRemanente,
            dineroPerdido: dineroPerdido ?? 0,
          } as any,
        },
      });
    }
  }

  // ── Report ───────────────────────────────────────────────────────────────
  const bar = '─'.repeat(80);
  console.log(bar);
  console.log(`TireVidaSnapshots processed: ${snaps.length}`);
  console.log(`  will update:    ${snapUpdated}`);
  console.log(`  already correct: ${snapUnchanged}`);
  console.log(`  uncomputable:   ${snapUncomputable}`);
  console.log(bar);
  console.log('Sample snapshot updates (up to 10):');
  for (const p of preview) {
    console.log(`  ${p.id.slice(0, 8)}…  before=${p.before}  →  after=${p.after}   [${p.inputs}]`);
  }
  console.log(bar);
  console.log(`Tires in 'fin' with legacy desechos JSON: ${finTires.length}`);
  console.log(`  will update:    ${legacyUpdated}`);
  console.log(`  already correct: ${legacyUnchanged}`);
  console.log(`  skipped (no data): ${legacySkipped}`);
  console.log(bar);
  console.log('Sample legacy JSON updates (up to 10):');
  for (const p of legacyPreview) {
    console.log(
      `  ${p.placa.padEnd(14)} remanente: ${String(p.remanenteBefore).padEnd(10)} → ${p.remanenteAfter}mm    dineroPerdido: $${p.dineroPerdido ?? 'n/a'}`,
    );
  }
  console.log(bar);
  console.log(APPLY ? `✅ Applied.` : `Dry-run. Re-run with --apply to write changes.`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
