/**
 * Backfills Inspeccion.inspeccionadoPorId for historical rows that only
 * captured the free-form `inspeccionadoPorNombre` (the id field is a
 * recent addition). For each inspection row we:
 *
 *   1. Find the inspection's company (via tire.companyId).
 *   2. Look up users in that company whose name matches the recorded
 *      inspector name (case-insensitive, trimmed).
 *   3. If exactly one user matches, write their id onto the row. Skip
 *      otherwise — ambiguous or unknown inspectors stay as free text.
 *
 * Usage:
 *   npx ts-node scripts/backfill-inspector-id.ts [--apply]
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

function norm(s: string): string {
  return s.trim().toLowerCase();
}

async function main() {
  const rows = await prisma.inspeccion.findMany({
    where: {
      inspeccionadoPorId:     null,
      inspeccionadoPorNombre: { not: null },
    },
    select: {
      id: true,
      inspeccionadoPorNombre: true,
      tire: { select: { companyId: true } },
    },
  });

  console.log(`Found ${rows.length} inspections missing inspector id.`);
  if (!rows.length) return;

  // Pre-load every user so we can resolve names in memory instead of per-row.
  const users = await prisma.user.findMany({
    select: { id: true, name: true, companyId: true },
  });

  // Map: companyId -> normalisedName -> user[] (to detect ambiguity)
  const byCompany = new Map<string, Map<string, Array<{ id: string; name: string }>>>();
  for (const u of users) {
    const key = u.companyId;
    let m = byCompany.get(key);
    if (!m) { m = new Map(); byCompany.set(key, m); }
    const n = norm(u.name);
    const arr = m.get(n) ?? [];
    arr.push({ id: u.id, name: u.name });
    m.set(n, arr);
  }

  let resolved = 0;
  let ambiguous = 0;
  let unknown = 0;
  const preview: Array<{ nombre: string; user: string; company: string }> = [];

  for (const r of rows) {
    const companyId = r.tire.companyId;
    const nombre = (r.inspeccionadoPorNombre ?? '').trim();
    if (!nombre) { unknown++; continue; }
    const matches = byCompany.get(companyId)?.get(norm(nombre)) ?? [];
    if (matches.length === 1) {
      resolved++;
      if (preview.length < 15) {
        preview.push({ nombre, user: matches[0].id, company: companyId });
      }
      if (APPLY) {
        await prisma.inspeccion.update({
          where: { id: r.id },
          data:  { inspeccionadoPorId: matches[0].id },
        });
      }
    } else if (matches.length > 1) {
      ambiguous++;
    } else {
      unknown++;
    }
  }

  const bar = '─'.repeat(80);
  console.log(bar);
  console.log(`Resolved:   ${resolved}`);
  console.log(`Ambiguous:  ${ambiguous}  (multiple users with same name — left as free text)`);
  console.log(`Unknown:    ${unknown}    (no matching user — left as free text)`);
  console.log(bar);
  console.log('Sample resolutions (up to 15):');
  for (const p of preview) {
    console.log(`  ${p.nombre.padEnd(22)} → user ${p.user.slice(0, 8)}…`);
  }
  console.log(bar);
  console.log(APPLY ? `✅ Applied.` : `Dry-run. Re-run with --apply to write.`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
