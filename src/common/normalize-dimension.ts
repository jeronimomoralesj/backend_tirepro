// Canonical tire dimension format used everywhere we persist or compare
// dimensions. Examples:
//   "295/80 r22.5" → "295/80R22.5"
//   "295/80 R 22.5" → "295/80R22.5"
//   " 12r22.5 "    → "12R22.5"
//   "11R22.5"      → "11R22.5"
//
// Rules:
//   • Strip all whitespace
//   • Upper-case the whole string (only the "r" matters in practice, but
//     upper-casing digits/slashes/periods is a no-op)
//
// Every write path (tire create, catalog upsert, listing create/update,
// bid/purchase items) must pass dimensions through this function so new
// records match the canonical form produced by the one-shot migration.
export function normalizeDimension(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.replace(/\s+/g, '').toUpperCase();
}
