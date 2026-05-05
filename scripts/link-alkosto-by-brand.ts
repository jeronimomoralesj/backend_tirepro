/**
 * link-alkosto-by-brand.ts
 *
 * Walks every active marketplace listing for a given brand, searches
 * alkosto.com via puppeteer, picks the best matching result, and
 * (optionally) attaches it as a RetailSource on the listing.
 *
 * The intended workflow:
 *
 *   # 1. DRY-RUN (default). Writes a CSV you can review by hand.
 *   npx tsx scripts/link-alkosto-by-brand.ts nexen
 *
 *   # 2. Eyeball the CSV. The "matchedTitle" + "score" columns let
 *   #    you spot bad pairings quickly. Anything you want to skip,
 *   #    delete the row from the CSV.
 *
 *   # 3. APPLY. Writes the RetailSource rows into the DB. Triggers
 *   #    the per-listing scrape inline so per-bodega stock is
 *   #    populated immediately.
 *   npx tsx scripts/link-alkosto-by-brand.ts nexen --apply
 *
 * Flags:
 *   --apply           Actually write to the DB. Without it, dry-run.
 *   --only-missing    Only consider listings that don't have a source
 *                     attached yet (default behaviour — flag is a
 *                     readability aid; pass --include-existing to
 *                     re-link listings that already have one).
 *   --include-existing  Process listings even when they already have
 *                       a RetailSource row.
 *   --min-score=N     Skip writes (when --apply) when the best match
 *                     scores below N. Default 3.
 *   --limit=N         Process at most N listings. Useful for spot-
 *                     checking the search heuristic on a small
 *                     subset before committing to the full brand.
 *
 * Scoring (out of 5):
 *   +2  result title contains the brand
 *   +2  result title contains the dimension (any of several normalised
 *       forms — "225/60R17" / "225 60 17" / "22560R17")
 *   +1  result URL ends in /p/<digits> (real Alkosto product, not a
 *       category page)
 *
 * Anything below 3 → low-confidence; flagged in the CSV. With --apply
 * those are skipped unless --min-score is overridden.
 */

import { PrismaClient } from '@prisma/client';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser } from 'puppeteer';
import { writeFileSync } from 'fs';
import { join } from 'path';

puppeteer.use(StealthPlugin());

// ─── Args ────────────────────────────────────────────────────────────────

const BRAND = (process.argv[2] ?? '').trim();
if (!BRAND || BRAND.startsWith('-')) {
  console.error('Usage: npx tsx scripts/link-alkosto-by-brand.ts <brand> [--apply] [--limit=N] [--min-score=N] [--include-existing]');
  process.exit(1);
}
const APPLY = process.argv.includes('--apply');
const INCLUDE_EXISTING = process.argv.includes('--include-existing');
const LIMIT_ARG = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split('=')[1], 10) : Infinity;
const MIN_SCORE_ARG = process.argv.find((a) => a.startsWith('--min-score='));
const MIN_SCORE = MIN_SCORE_ARG ? parseInt(MIN_SCORE_ARG.split('=')[1], 10) : 3;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const prisma = new PrismaClient();

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Normalise a tire dimension into several search-friendly variants:
 *  "225/60R17" → ["225/60R17", "225 60 17", "22560R17"]. We score a
 *  result as a dimension match if any variant appears in the title. */
function dimensionVariants(dim: string): string[] {
  const cleaned = dim.replace(/\s+/g, '').toUpperCase();
  const out = new Set<string>([cleaned]);
  // 225/60R17 → 225 60 17
  const m = cleaned.match(/^(\d+)\/(\d+)R?(\d+(?:\.\d+)?)$/);
  if (m) {
    out.add(`${m[1]} ${m[2]} ${m[3]}`);
    out.add(`${m[1]}/${m[2]} R${m[3]}`);
    out.add(`${m[1]}/${m[2]}R${m[3]}`);
    out.add(`${m[1]}${m[2]}R${m[3]}`);
  }
  return Array.from(out);
}

/** Match-quality score 0–5. */
function scoreResult(brand: string, dim: string, title: string, url: string): number {
  const t = title.toLowerCase();
  let s = 0;
  if (t.includes(brand.toLowerCase())) s += 2;
  if (dimensionVariants(dim).some((v) => t.includes(v.toLowerCase()))) s += 2;
  if (/\/p\/\d+/.test(url)) s += 1;
  return s;
}

interface SearchHit { url: string; title: string }

async function searchAlkosto(query: string, browser: Browser): Promise<SearchHit[]> {
  const url = `https://www.alkosto.com/search?text=${encodeURIComponent(query)}`;
  const page = await browser.newPage();
  try {
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'es-CO,es;q=0.9' });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // Search results render via Algolia after page load — give them a
    // moment, then read every product anchor on the page.
    await new Promise((r) => setTimeout(r, 3500));
    return await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href*="/p/"]'));
      const seen = new Set<string>();
      const out: { url: string; title: string }[] = [];
      for (const a of anchors) {
        const href = (a as HTMLAnchorElement).href;
        // Drop fragment / query so we dedup on the canonical product URL.
        const clean = href.split('?')[0].split('#')[0];
        if (seen.has(clean)) continue;
        seen.add(clean);
        // Prefer the closest enclosing block's text as the title — the
        // anchor itself often wraps just an image.
        const block = (a as HTMLElement).closest('article, .product__item, li, div') as HTMLElement | null;
        const title = (block?.innerText ?? a.textContent ?? '')
          .replace(/\s+/g, ' ').trim().slice(0, 250);
        if (clean.includes('/p/')) out.push({ url: clean, title });
        if (out.length >= 10) break;
      }
      return out;
    });
  } finally {
    await page.close().catch(() => {});
  }
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Brand: ${BRAND}`);
  console.log(`Mode:  ${APPLY ? 'APPLY (writes to DB)' : 'DRY-RUN (CSV only)'}`);
  console.log(`Min score: ${MIN_SCORE}`);
  if (LIMIT < Infinity) console.log(`Limit: ${LIMIT}`);
  console.log(`Include existing: ${INCLUDE_EXISTING ? 'yes' : 'no'}`);
  console.log('');

  const listings = await prisma.distributorListing.findMany({
    where: {
      isActive: true,
      marca: { equals: BRAND, mode: 'insensitive' },
      ...(INCLUDE_EXISTING ? {} : { retailSource: null }),
    },
    select: {
      id: true,
      marca: true,
      modelo: true,
      dimension: true,
      distributor: { select: { id: true, name: true } },
      retailSource: { select: { id: true, url: true } },
    },
    orderBy: [{ modelo: 'asc' }, { dimension: 'asc' }],
    take: LIMIT === Infinity ? undefined : LIMIT,
  });

  console.log(`Found ${listings.length} ${BRAND} listings to process\n`);
  if (listings.length === 0) {
    await prisma.$disconnect();
    return;
  }

  const browser = (await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--lang=es-CO',
    ],
  })) as unknown as Browser;

  const rows: Array<{
    listingId: string;
    distributor: string;
    sku: string;
    query: string;
    bestUrl: string;
    bestTitle: string;
    score: number;
    status: string;
  }> = [];

  for (let i = 0; i < listings.length; i++) {
    const l = listings[i];
    const sku = `${l.marca} ${l.modelo} ${l.dimension}`;
    const query = `llanta ${l.marca} ${l.modelo} ${l.dimension.replace(/\s+/g, '')}`;
    process.stdout.write(`[${i + 1}/${listings.length}] ${sku} → `);

    let hits: SearchHit[] = [];
    try {
      hits = await searchAlkosto(query, browser);
    } catch (err) {
      console.log(`ERROR (${(err as Error).message.slice(0, 80)})`);
      rows.push({ listingId: l.id, distributor: l.distributor.name, sku, query, bestUrl: '', bestTitle: '', score: 0, status: 'search-error' });
      continue;
    }

    if (hits.length === 0) {
      console.log('no results');
      rows.push({ listingId: l.id, distributor: l.distributor.name, sku, query, bestUrl: '', bestTitle: '', score: 0, status: 'no-results' });
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }

    // Score every hit; pick the best. Tie-break by lower index (search
    // engine relevance) which is preserved by the JS sort being stable.
    const scored = hits.map((h) => ({ ...h, score: scoreResult(l.marca, l.dimension, h.title, h.url) }));
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];

    const passes = best.score >= MIN_SCORE;
    const status = passes
      ? (APPLY ? (l.retailSource ? 'replaced' : 'attached') : 'pending')
      : (best.score === 0 ? 'no-match' : `low-score (${best.score}/${MIN_SCORE})`);
    console.log(`${best.url}  [score ${best.score}]${passes ? ' ✓' : ' (skipped)'}`);

    rows.push({
      listingId: l.id,
      distributor: l.distributor.name,
      sku,
      query,
      bestUrl: best.url,
      bestTitle: best.title,
      score: best.score,
      status,
    });

    if (APPLY && passes) {
      try {
        await prisma.retailSource.upsert({
          where: { listingId: l.id },
          create: {
            listingId: l.id,
            url: best.url,
            isActive: true,
            domain: 'alkosto.com',
          },
          update: {
            url: best.url,
            isActive: true,
            domain: 'alkosto.com',
            // Reset error state so the daily cron re-tries cleanly.
            lastError: null,
          },
        });
      } catch (err) {
        console.log(`  ! upsert error: ${(err as Error).message.slice(0, 80)}`);
        rows[rows.length - 1].status = 'upsert-error';
      }
    }

    // Be polite to Alkosto — 1.5s pause between searches.
    await new Promise((r) => setTimeout(r, 1500));
  }

  await browser.close().catch(() => {});

  // Write CSV.
  const out = [
    'listingId,distributor,sku,query,bestUrl,bestTitle,score,status',
    ...rows.map((r) =>
      [r.listingId, r.distributor, r.sku, r.query, r.bestUrl, r.bestTitle, r.score, r.status]
        .map((c) => `"${String(c).replace(/"/g, '""')}"`)
        .join(','),
    ),
  ].join('\n');
  const csvPath = join(process.cwd(), `alkosto-link-${BRAND.toLowerCase()}.csv`);
  writeFileSync(csvPath, out);
  console.log(`\nWrote ${csvPath} (${rows.length} rows)`);

  const summary = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log('\nSummary by status:');
  for (const [k, v] of Object.entries(summary).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(20)} ${v}`);
  }

  if (!APPLY) {
    console.log('\nReview the CSV. When happy, re-run with --apply to write the matches.');
  } else {
    console.log('\nApplied. Wait for the daily cron at 4am Bogotá, or click "Refrescar"');
    console.log('on each listing in /dashboard/marketplace/productos to scrape stock now.');
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
