/**
 * TirePro Catalog Price Scraper v2 — full Colombian market sweep.
 *
 * Goes page by page through every source, collects ALL tires, then:
 *  1. Resets all catalog prices to 0
 *  2. For each scraped tire: create or update the catalog entry (average prices)
 *  3. After ALL sources are scraped: delete SKUs still at price=0 (not in market)
 *
 * Safety: requires ≥10 tires per source, and ≥3 sources succeeding, else no deletes.
 *
 * Usage:
 *   npx tsx scripts/scrape-prices.ts                 # full run
 *   npx tsx scripts/scrape-prices.ts --dry-run        # preview only
 *   npx tsx scripts/scrape-prices.ts --no-delete       # skip deletion step
 */

import { PrismaClient } from '@prisma/client';
import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';

const prisma = new PrismaClient();

// ─── Config ───────────────────────────────────────────────────────────────────

const DELAY_MS        = 800;
const REQUEST_TIMEOUT = 20_000;
const PRICE_MIN       = 100_000;
const PRICE_MAX       = 12_000_000;
const MIN_TIRES_PER_SOURCE = 10;    // source must yield ≥10 tires or it's considered failed
const MIN_SOURCES_OK       = 3;     // ≥3 sources must succeed before we allow deletes
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScrapedTire {
  name:      string;   // full product name from website
  marca:     string;   // brand
  modelo:    string;   // model / design
  dimension: string;   // e.g. "295/80R22.5"
  price:     number;   // COP
  source:    string;
  url:       string;
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

const http: AxiosInstance = axios.create({
  timeout: REQUEST_TIMEOUT,
  headers: { 'User-Agent': UA },
  maxRedirects: 5,
  validateStatus: (s) => s < 500,
});

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function getJSON(url: string): Promise<any | null> {
  try {
    const r = await http.get(url, { headers: { Accept: 'application/json' } });
    return r.status < 400 ? r.data : null;
  } catch { return null; }
}

async function getHTML(url: string): Promise<string | null> {
  try {
    const r = await http.get(url, { headers: { Accept: 'text/html' } });
    return r.status < 400 && typeof r.data === 'string' ? r.data : null;
  } catch { return null; }
}

async function postJSON(url: string, body: any, headers: Record<string, string> = {}): Promise<any | null> {
  try {
    const r = await http.post(url, body, { headers: { 'Content-Type': 'application/json', ...headers } });
    return r.status < 400 ? r.data : null;
  } catch { return null; }
}

// ─── Tire data extraction helpers ─────────────────────────────────────────────

/** Normalize dimension: "295/80 R 22.5" → "295/80R22.5" */
function normDim(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase().replace(/(\d)R/i, '$1R');
}

/** Extract dimension from a product name string */
function extractDimension(name: string): string {
  // Match patterns like: 295/80R22.5, 295/80 R22.5, 295/80 R 22.5, 11R22.5, 215/75R17.5
  const m = name.match(/(\d{2,3}\/?\d{0,3})\s*R\s*(\d{2}\.?\d?)/i);
  if (m) return normDim(`${m[1]}R${m[2]}`);
  // Fallback: dimension-like patterns with spaces
  const m2 = name.match(/(\d{2,3})\s*[\/]\s*(\d{2,3})\s*R?\s*(\d{2}\.?\d?)/i);
  if (m2) return normDim(`${m2[1]}/${m2[2]}R${m2[3]}`);
  return '';
}

/** Extract brand from product name using known patterns */
function extractBrand(name: string): string {
  // Clean and titlecase
  const words = name.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
  // Common brands to detect
  const BRANDS = [
    // Premium
    'Michelin','Bridgestone','Continental','Goodyear','Pirelli','Yokohama',
    // Mid-range
    'Hankook','Kumho','Firestone','Dunlop','Toyo','Cooper','BFGoodrich',
    'General','Falken','Nitto','Nexen','Laufenn','Maxxis','Kelly',
    // Economy / Chinese
    'Triangle','Westlake','Sailun','Double Coin','Linglong','Aeolus',
    'GiTi','GT Radial','Leao','Federal','Fullrun','Chaoyang','Austone',
    'Zeta','Zmax','Royal Black','Aufine','Aplus','Kapsen','Compasal',
    'Roadx','Boto','JK Tyre','Mitas','Ovation','Tracmax','Wanli',
    'Windforce','Haida','Joyall','Wanda','Radar','Zextour','Drc',
    'Lanvigator','Sunfull','Cachland','Arivo','Minerva','Torque',
    'Powertrac','Farroad','Saferich','Goodride','Giti','Constancy',
    'Hifly','Three-A','Yatone','Sunwide','Trazano','Ilink','Bearway',
    'Annaite','Centurion','Longmarch','Koryo','Samson','Deestone',
    'BKT','Ceat','MRF','Apollo','TVS','Ralco','JK','Vikrant',
    'Achilles','Accelera','Forceum','Zenises','Otani','Nankang',
    'Petlas','Davanti','Nordexx','Rotalla','Rovelo','Presa',
    'Starmaxx','Matador','Barum','Uniroyal','Semperit','Viking',
    'Vredestein','Nokian','Heidenau','Metzeler','Avon',
  ];
  const lo = name.toLowerCase();
  for (const b of BRANDS) {
    if (lo.includes(b.toLowerCase())) return b.charAt(0).toUpperCase() + b.slice(1).toLowerCase();
  }
  // Fallback: first word that's >2 chars and not a number or dimension
  for (const w of words) {
    if (w.length > 2 && !/^\d/.test(w) && !/^llanta/i.test(w) && !/^cami/i.test(w) && !/^auto/i.test(w))
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }
  return '';
}

/** Extract model name from product name (after removing brand and dimension) */
function extractModel(name: string, brand: string): string {
  let clean = name;
  if (brand) clean = clean.replace(new RegExp(brand, 'gi'), '');
  // Remove dimension
  clean = clean.replace(/\d{2,3}\/?(\d{2,3})?\s*R?\s*\d{2}\.?\d?\s*((\d{1,2}PR)?)/gi, '');
  // Remove common prefixes
  clean = clean.replace(/^(llanta|llantas?|cami[oó]n|auto|suv)\s*/gi, '');
  clean = clean.replace(/\s+/g, ' ').trim();
  return clean || '';
}

function validPrice(p: number): boolean {
  return p >= PRICE_MIN && p <= PRICE_MAX;
}

// ─── WooCommerce Store API scraper (paginated) ───────────────────────────────

async function scrapeWcAll(host: string, sourceName: string): Promise<ScrapedTire[]> {
  const results: ScrapedTire[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const url = `https://${host}/wp-json/wc/store/products?per_page=${perPage}&page=${page}`;
    const data = await getJSON(url);

    if (!Array.isArray(data) || data.length === 0) break;

    for (const p of data) {
      const name = (p.name || '').replace(/<[^>]*>/g, '').trim();
      const priceRaw = parseInt(p.prices?.price || p.prices?.sale_price || p.prices?.regular_price || '0', 10);
      if (!name || !validPrice(priceRaw)) continue;

      const dimension = extractDimension(name);
      if (!dimension) continue; // not a tire or can't parse dimension

      // Try to get brand from WC categories/tags first, then from name
      const wcBrand = (p.categories || []).concat(p.tags || [])
        .map((c: any) => c.name || '').find((n: string) => {
          const lo = n.toLowerCase();
          return lo.length > 2 && !lo.includes('llanta') && !lo.includes('cami') &&
            !lo.includes('auto') && !lo.includes('rin') && !/^\d/.test(lo);
        }) || '';
      const brand = extractBrand(name) || wcBrand || extractBrand(p.short_description || '');
      const model = extractModel(name, brand);

      results.push({
        name, marca: brand, modelo: model, dimension,
        price: priceRaw, source: sourceName,
        url: p.permalink || `https://${host}`,
      });
    }

    console.log(`    ${sourceName} page ${page}: ${data.length} products (${results.length} tires total)`);

    if (data.length < perPage) break; // last page
    page++;
    await sleep(DELAY_MS);
  }

  return results;
}

// ─── WooCommerce HTML scraper (for sites where API returns 406) ──────────────

async function scrapeWcHTML(host: string, sourceName: string): Promise<ScrapedTire[]> {
  const results: ScrapedTire[] = [];
  let page = 1;

  while (true) {
    const url = `https://${host}/shop/page/${page}/`;
    const html = await getHTML(url);
    if (!html) break;

    const $ = cheerio.load(html);
    let found = 0;

    $('li.product, .product-item, article.product, .products .product').each((_, el) => {
      const $el = $(el);
      const title = ($el.find('.woocommerce-loop-product__title, .product-title, h2, h3').first().text() || '').trim();
      const priceText = (
        $el.find('.price ins .woocommerce-Price-amount').first().text() ||
        $el.find('.price .woocommerce-Price-amount').first().text() ||
        $el.find('.price .amount').first().text() ||
        $el.find('.price').first().text() || ''
      ).trim();

      const price = parseCOP(priceText);
      if (!title || !validPrice(price)) return;

      const dimension = extractDimension(title);
      if (!dimension) return;

      const brand = extractBrand(title);
      const model = extractModel(title, brand);
      const link = $el.find('a').first().attr('href') || `https://${host}`;

      results.push({ name: title, marca: brand, modelo: model, dimension, price, source: sourceName, url: link });
      found++;
    });

    // Also try JSON-LD
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).html() || '');
        const items = json['@type'] === 'Product' ? [json]
          : (json['@graph'] || []).filter((n: any) => n['@type'] === 'Product');
        for (const p of items) {
          const price = parseCOP(p.offers?.price ?? p.offers?.[0]?.price ?? '');
          if (!validPrice(price)) continue;
          const name = (p.name || '').trim();
          const dimension = extractDimension(name);
          if (!dimension) continue;
          const brand = extractBrand(name);
          results.push({ name, marca: brand, modelo: extractModel(name, brand), dimension, price, source: sourceName, url: p.url || url });
          found++;
        }
      } catch {}
    });

    console.log(`    ${sourceName} page ${page}: ${found} tires (${results.length} total)`);
    if (found === 0) break;
    page++;
    await sleep(DELAY_MS);
  }

  return results;
}

function parseCOP(raw: string | number): number {
  if (typeof raw === 'number') return validPrice(raw) ? Math.round(raw) : 0;
  if (!raw) return 0;
  let s = String(raw).replace(/[^\d.,]/g, '').trim();
  if (!s) return 0;
  if ((s.match(/\./g) || []).length >= 2) s = s.replace(/\./g, '');
  else if (s.includes('.') && s.split('.')[1]?.length === 3) s = s.replace('.', '');
  s = s.replace(/,/g, '');
  const n = parseFloat(s);
  return validPrice(n) ? Math.round(n) : 0;
}

// ─── Algolia-based scraper (Alkosto, Alkomprar) ──────────────────────────────

async function scrapeAlgolia(
  appId: string,
  apiKey: string,
  indexName: string,
  sourceName: string,
  baseUrl: string,
  query: string = 'llantas',
): Promise<ScrapedTire[]> {
  const results: ScrapedTire[] = [];
  const hitsPerPage = 100;
  let page = 0;

  while (true) {
    const data = await postJSON(
      `https://${appId}-dsn.algolia.net/1/indexes/${indexName}/query`,
      {
        query,
        hitsPerPage,
        page,
        attributesToRetrieve: ['name_text_es', 'marca_text', 'pricevalue_cop_double', 'url_es_string',
          'ancho-llanta_string_mv', 'perfil_string_mv', 'rin_string_mv'],
      },
      { 'X-Algolia-Application-Id': appId, 'X-Algolia-API-Key': apiKey },
    );

    if (!data?.hits?.length) break;

    for (const h of data.hits) {
      const name  = h.name_text_es || '';
      const price = h.pricevalue_cop_double || 0;
      if (!name || !validPrice(price)) continue;

      // Build dimension from structured fields or parse from name
      let dimension = '';
      const ancho  = h['ancho-llanta_string_mv']?.[0];
      const perfil = h['perfil_string_mv']?.[0];
      const rin    = h['rin_string_mv']?.[0];
      if (ancho && rin) {
        dimension = normDim(perfil ? `${ancho}/${perfil}R${rin}` : `${ancho}R${rin}`);
      }
      if (!dimension) dimension = extractDimension(name);
      if (!dimension) continue;

      const brand = h.marca_text || extractBrand(name);
      const model = extractModel(name, brand);
      const url   = h.url_es_string ? `${baseUrl}${h.url_es_string}` : baseUrl;

      results.push({ name, marca: brand, modelo: model, dimension, price: Math.round(price), source: sourceName, url });
    }

    console.log(`    ${sourceName} page ${page + 1}/${data.nbPages}: ${data.hits.length} hits (${results.length} tires)`);

    if (page + 1 >= data.nbPages) break;
    page++;
    await sleep(DELAY_MS);
  }

  return results;
}

// ─── Homecenter scraper (HTML) ───────────────────────────────────────────────

async function scrapeHomecenter(): Promise<ScrapedTire[]> {
  const results: ScrapedTire[] = [];
  let offset = 0;
  const pageSize = 48;

  while (true) {
    const url = `https://www.homecenter.com.co/homecenter-co/search?Ntt=llantas&No=${offset}&Nrpp=${pageSize}`;
    const html = await getHTML(url);
    if (!html) break;

    const $ = cheerio.load(html);
    let found = 0;

    // Homecenter uses specific product card patterns
    $('[class*="product"], .grid-item, article').each((_, el) => {
      const $el = $(el);
      const title = ($el.find('[class*="product-name"], [class*="title"], h3, h2').first().text() || '').trim();
      const priceText = ($el.find('[class*="price"] [class*="value"], [class*="price"]').first().text() || '').trim();
      const price = parseCOP(priceText);
      if (!title || !validPrice(price)) return;
      const dimension = extractDimension(title);
      if (!dimension) return;
      const brand = extractBrand(title);
      results.push({ name: title, marca: brand, modelo: extractModel(title, brand), dimension, price, source: 'homecenter', url });
      found++;
    });

    // JSON-LD fallback
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).html() || '');
        const items = json['@type'] === 'ItemList'
          ? (json.itemListElement || []).map((i: any) => i.item || i)
          : json['@type'] === 'Product' ? [json] : [];
        for (const p of items) {
          const price = parseCOP(p.offers?.price ?? '');
          if (!validPrice(price)) continue;
          const name = p.name || '';
          const dimension = extractDimension(name);
          if (!dimension) continue;
          const brand = extractBrand(name);
          results.push({ name, marca: brand, modelo: extractModel(name, brand), dimension, price, source: 'homecenter', url: p.url || '' });
          found++;
        }
      } catch {}
    });

    console.log(`    homecenter offset ${offset}: ${found} tires (${results.length} total)`);
    if (found === 0) break;
    offset += pageSize;
    await sleep(DELAY_MS);
  }

  return results;
}

// ─── Exito / Jumbo (VTEX) scraper ────────────────────────────────────────────

async function scrapeVTEX(host: string, sourceName: string): Promise<ScrapedTire[]> {
  const results: ScrapedTire[] = [];
  let from = 0;
  const step = 50; // VTEX max is 50 per request

  while (true) {
    const to = from + step - 1;
    const url = `https://${host}/api/catalog_system/pub/products/search/llantas?_from=${from}&_to=${to}`;
    const data = await getJSON(url);

    if (!Array.isArray(data) || data.length === 0) break;

    for (const p of data) {
      const name  = p.productName || p.productTitle || '';
      const price = p.items?.[0]?.sellers?.[0]?.commertialOffer?.Price || 0;
      if (!name || !validPrice(price)) continue;

      const dimension = extractDimension(name);
      if (!dimension) continue;

      const brand = p.brand || extractBrand(name);
      const model = extractModel(name, brand);
      const pUrl  = `https://${host}/${p.linkText || ''}/p`;

      results.push({ name, marca: brand, modelo: model, dimension, price: Math.round(price), source: sourceName, url: pUrl });
    }

    console.log(`    ${sourceName} ${from}–${to}: ${data.length} products (${results.length} tires)`);

    if (data.length < step) break;
    from += step;
    await sleep(DELAY_MS);
  }

  return results;
}

// ─── Source registry ──────────────────────────────────────────────────────────

interface Source {
  name: string;
  fetch: () => Promise<ScrapedTire[]>;
}

const SOURCES: Source[] = [
  // WooCommerce Store API sites
  { name: 'macrotires',      fetch: () => scrapeWcAll('macrotires.com.co', 'macrotires') },
  { name: 'llantasdelcamino', fetch: () => scrapeWcAll('www.llantasdelcamino.com', 'llantasdelcamino') },
  { name: 'tecnillantas',    fetch: () => scrapeWcAll('www.tecnillantas.co', 'tecnillantas') },
  { name: 'tractomulas',     fetch: () => scrapeWcAll('www.tractomulasdecolombia.com', 'tractomulas') },
  { name: 'interllantas',    fetch: () => scrapeWcAll('interllantas.com', 'interllantas') },
  { name: 'tullanta',        fetch: () => scrapeWcAll('tullanta.com', 'tullanta') },
  { name: 'susllantas',      fetch: () => scrapeWcAll('www.susllantas.com.co', 'susllantas') },
  { name: 'energiteca',      fetch: () => scrapeWcAll('www.energiteca.com', 'energiteca') },
  { name: 'lasllantas',      fetch: () => scrapeWcAll('lasllantas.com', 'lasllantas') },
  { name: 'tellantas',       fetch: () => scrapeWcAll('www.tellantas.com', 'tellantas') },
  { name: 'acostallantas',   fetch: () => scrapeWcAll('www.acostallantas.com', 'acostallantas') },

  // HTML fallback (WC API returns 406)
  { name: 'industrypartes',  fetch: () => scrapeWcHTML('industrypartes.com', 'industrypartes') },
  { name: 'casalopez',       fetch: () => scrapeWcHTML('www.casalopez.com.co', 'casalopez') },

  // Algolia-based
  {
    name: 'alkosto',
    fetch: () => scrapeAlgolia('QX5IPS1B1Q', '7a8800d62203ee3a9ff1cdf74f99b268',
      'alkostoIndexAlgoliaPRD', 'alkosto', 'https://www.alkosto.com'),
  },
  {
    name: 'alkomprar',
    fetch: () => scrapeAlgolia('QX5IPS1B1Q', '7a8800d62203ee3a9ff1cdf74f99b268',
      'alkomprarIndexAlgoliaPRD', 'alkomprar', 'https://www.alkomprar.com'),
  },

  // VTEX sites
  { name: 'exito',  fetch: () => scrapeVTEX('www.exito.com', 'exito') },
  { name: 'jumbo',  fetch: () => scrapeVTEX('www.jumbocolombia.com', 'jumbo') },

  // Homecenter
  { name: 'homecenter', fetch: () => scrapeHomecenter() },
];

// ─── Matching & aggregation ───────────────────────────────────────────────────

/** Key for matching: brand + dimension (lowercase, normalized) */
function skuKey(marca: string, dimension: string): string {
  return `${marca.toLowerCase().trim()}|${normDim(dimension)}`;
}

function medianPrice(prices: number[]): number {
  if (!prices.length) return 0;
  const sorted = [...prices].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function avgPrice(prices: number[]): number {
  if (!prices.length) return 0;
  // IQR outlier removal
  const sorted = [...prices].sort((a, b) => a - b);
  if (sorted.length < 4) return Math.round(sorted.reduce((s, p) => s + p, 0) / sorted.length);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  const clean = sorted.filter(p => p >= q1 - 1.5 * iqr && p <= q3 + 1.5 * iqr);
  if (!clean.length) return medianPrice(sorted);
  return Math.round(clean.reduce((s, p) => s + p, 0) / clean.length);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args     = process.argv.slice(2);
  const dryRun   = args.includes('--dry-run');
  const noDelete = args.includes('--no-delete');

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  TirePro Catalog Price Scraper v2 — Full Market Sweep');
  console.log('═══════════════════════════════════════════════════════════════');
  if (dryRun)   console.log('  *** DRY RUN ***');
  if (noDelete) console.log('  *** NO DELETE ***');
  console.log(`  Sources: ${SOURCES.length}`);
  console.log('');

  // ── Phase 1: Scrape all sources ───────────────────────────────────────────
  const allTires: ScrapedTire[] = [];
  const sourceStats: { name: string; count: number; ok: boolean }[] = [];

  for (const src of SOURCES) {
    console.log(`\n▸ Scraping ${src.name}...`);
    try {
      const tires = await src.fetch();
      const ok = tires.length >= MIN_TIRES_PER_SOURCE;
      sourceStats.push({ name: src.name, count: tires.length, ok });
      if (ok) {
        allTires.push(...tires);
        console.log(`  ✓ ${src.name}: ${tires.length} tires`);
      } else {
        console.log(`  ⚠ ${src.name}: only ${tires.length} tires (min ${MIN_TIRES_PER_SOURCE}) — excluded`);
      }
    } catch (e: any) {
      sourceStats.push({ name: src.name, count: 0, ok: false });
      console.log(`  ✗ ${src.name}: ${e.message}`);
    }
    await sleep(DELAY_MS * 2);
  }

  const okSources = sourceStats.filter(s => s.ok).length;
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Scraping complete: ${allTires.length} tires from ${okSources}/${SOURCES.length} sources`);
  sourceStats.forEach(s => console.log(`  ${s.ok ? '✓' : '✗'} ${s.name}: ${s.count}`));
  console.log('');

  if (allTires.length === 0) {
    console.log('No tires scraped. Aborting.');
    await prisma.$disconnect();
    return;
  }

  // ── Phase 2: Group by brand + dimension ───────────────────────────────────
  // Map of skuKey → array of prices + best name/model
  const priceMap = new Map<string, { prices: number[]; marca: string; modelo: string; dimension: string; sources: Set<string>; url: string }>();

  for (const t of allTires) {
    if (!t.marca || !t.dimension) continue;
    const key = skuKey(t.marca, t.dimension);
    if (!priceMap.has(key)) {
      priceMap.set(key, { prices: [], marca: t.marca, modelo: t.modelo, dimension: normDim(t.dimension), sources: new Set(), url: t.url });
    }
    const entry = priceMap.get(key)!;
    entry.prices.push(t.price);
    entry.sources.add(t.source);
    // Keep the longest model name (usually most descriptive)
    if (t.modelo.length > entry.modelo.length) entry.modelo = t.modelo;
  }

  console.log(`${priceMap.size} unique brand+dimension combinations found.`);

  // ── Phase 3: Load current catalog ─────────────────────────────────────────
  const catalog = await prisma.tireMasterCatalog.findMany();
  const catalogByKey = new Map<string, typeof catalog[0]>();
  for (const sku of catalog) {
    catalogByKey.set(skuKey(sku.marca, sku.dimension), sku);
  }
  console.log(`${catalog.length} existing SKUs in catalog.`);

  // ── Phase 4: Compute updates, creates, deletes ────────────────────────────
  const toUpdate: { id: string; price: number; sources: number }[] = [];
  const toCreate: { marca: string; modelo: string; dimension: string; price: number; sources: number }[] = [];
  const matchedKeys = new Set<string>();

  for (const [key, entry] of priceMap) {
    const price = avgPrice(entry.prices);
    if (price <= 0) continue;

    matchedKeys.add(key);

    const existing = catalogByKey.get(key);
    if (existing) {
      toUpdate.push({ id: existing.id, price, sources: entry.sources.size });
    } else {
      toCreate.push({ marca: entry.marca, modelo: entry.modelo, dimension: entry.dimension, price, sources: entry.sources.size });
    }
  }

  // SKUs in catalog but NOT found on any website.
  // Safety: only delete a SKU if its brand was found on at least one source.
  // Premium brands (Michelin, Continental, etc.) often sell only through
  // authorized dealers not covered by our scrapers.
  const scrapedBrands = new Set<string>();
  for (const [, entry] of priceMap) scrapedBrands.add(entry.marca.toLowerCase());

  const toDelete: string[] = [];
  const toKeep:   string[] = []; // brands not covered → keep
  if (!noDelete && okSources >= MIN_SOURCES_OK) {
    for (const sku of catalog) {
      const key = skuKey(sku.marca, sku.dimension);
      if (matchedKeys.has(key)) continue; // found → keep

      // Only delete if we scraped at least 1 tire of this brand
      // (proving the brand is covered by our sources)
      if (scrapedBrands.has(sku.marca.toLowerCase())) {
        toDelete.push(sku.id);
      } else {
        toKeep.push(sku.id);
      }
    }
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Updates: ${toUpdate.length}`);
  console.log(`  Creates: ${toCreate.length}`);
  console.log(`  Deletes: ${toDelete.length}${okSources < MIN_SOURCES_OK ? ' (blocked: not enough sources)' : ''}`);
  if (toKeep.length > 0) console.log(`  Kept (brand not scraped): ${toKeep.length}`);
  console.log('═'.repeat(60));

  if (dryRun) {
    console.log('\n*** DRY RUN — no DB changes ***');
    console.log('\nSample updates (first 20):');
    for (const u of toUpdate.slice(0, 20)) {
      const sku = catalog.find(s => s.id === u.id)!;
      console.log(`  ${sku.marca} ${sku.modelo} (${sku.dimension}): $${(sku.precioCop ?? 0).toLocaleString('es-CO')} → $${u.price.toLocaleString('es-CO')} (${u.sources} src)`);
    }
    console.log('\nSample creates (first 20):');
    for (const c of toCreate.slice(0, 20)) {
      console.log(`  NEW: ${c.marca} ${c.modelo} (${c.dimension}): $${c.price.toLocaleString('es-CO')} (${c.sources} src)`);
    }
    if (toDelete.length > 0) {
      console.log(`\nSample deletes (first 20):`);
      for (const id of toDelete.slice(0, 20)) {
        const sku = catalog.find(s => s.id === id)!;
        console.log(`  DEL: ${sku.marca} ${sku.modelo} (${sku.dimension})`);
      }
    }
    await prisma.$disconnect();
    return;
  }

  // ── Phase 5: Apply changes ────────────────────────────────────────────────

  // Step 1: Reset prices to 0 ONLY for brands we actually scraped
  // (premium brands not covered by our sources keep their existing prices)
  const scrapedBrandsList = [...scrapedBrands];
  console.log(`\nResetting prices for ${scrapedBrandsList.length} scraped brands...`);
  if (scrapedBrandsList.length > 0) {
    await prisma.tireMasterCatalog.updateMany({
      where: { marca: { in: scrapedBrandsList, mode: 'insensitive' } },
      data: { precioCop: 0 },
    });
  }

  // Step 2: Update existing SKUs with scraped prices
  console.log(`Updating ${toUpdate.length} existing SKUs...`);
  let updated = 0;
  for (const u of toUpdate) {
    try {
      const sku = await prisma.tireMasterCatalog.findUnique({ where: { id: u.id }, select: { kmEstimadosReales: true } });
      const km = sku?.kmEstimadosReales;
      await prisma.tireMasterCatalog.update({
        where: { id: u.id },
        data: {
          precioCop: u.price,
          ...(km && km > 0 ? { cpkEstimado: Math.round((u.price / km) * 100) / 100 } : {}),
          notasColombia: `Scraper v2: $${u.price.toLocaleString('es-CO')} (${u.sources} fuentes). ${new Date().toISOString().slice(0, 10)}`,
        },
      });
      updated++;
    } catch {}
  }
  console.log(`  ✓ Updated ${updated}/${toUpdate.length}`);

  // Step 3: Create new SKUs
  console.log(`Creating ${toCreate.length} new SKUs...`);
  let created = 0;
  for (const c of toCreate) {
    try {
      const skuRef = `SCRAPED-${c.marca.toUpperCase().replace(/\s+/g, '')}-${c.modelo.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20)}-${c.dimension.replace(/[^A-Z0-9.]/gi, '')}`.slice(0, 64);
      // Check uniqueness
      const exists = await prisma.tireMasterCatalog.findUnique({ where: { skuRef } });
      const finalRef = exists ? `${skuRef}-${Date.now().toString(36)}` : skuRef;

      await prisma.tireMasterCatalog.create({
        data: {
          marca: c.marca,
          modelo: c.modelo,
          dimension: c.dimension,
          skuRef: finalRef,
          precioCop: c.price,
          fuente: 'scraper',
          notasColombia: `Scraper v2: $${c.price.toLocaleString('es-CO')} (${c.sources} fuentes). ${new Date().toISOString().slice(0, 10)}`,
        },
      });
      created++;
    } catch {}
  }
  console.log(`  ✓ Created ${created}/${toCreate.length}`);

  // Step 4: Delete SKUs with price still = 0 (not found anywhere)
  if (toDelete.length > 0 && okSources >= MIN_SOURCES_OK) {
    console.log(`Deleting ${toDelete.length} SKUs not found in Colombian market...`);
    const del = await prisma.tireMasterCatalog.deleteMany({ where: { id: { in: toDelete } } });
    console.log(`  ✓ Deleted ${del.count}`);
  } else if (toDelete.length > 0) {
    console.log(`⚠ Skipping deletes: only ${okSources} sources succeeded (need ${MIN_SOURCES_OK})`);
  }

  console.log(`\n✓ Done. Final catalog: ${await prisma.tireMasterCatalog.count()} SKUs`);
  await prisma.$disconnect();
}

main().catch(e => { console.error('Fatal:', e); prisma.$disconnect(); process.exit(1); });
