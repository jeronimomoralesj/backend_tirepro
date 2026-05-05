import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, Page, HTTPResponse } from 'puppeteer';

// Puppeteer-extra is a singleton — register stealth once at module load
// so the browser launched in fetchAlkostoRendered can't be fingerprinted
// as headless by Alkosto's frontend protections.
puppeteer.use(StealthPlugin());

/**
 * Single parsed pickup point — what the scraper hands back to the
 * caller before any DB write. Mirrors the RetailPickupPoint schema
 * minus the id/source fields the caller fills in.
 */
export interface ScrapedPickupPoint {
  externalId?: string | null;
  name: string;
  address?: string | null;
  city: string;          // normalised lowercase
  cityDisplay?: string | null;
  lat?: number | null;
  lng?: number | null;
  hours?: string | null;
  stockUnits: number;
}

export interface ScrapedSourceResult {
  url: string;
  domain: string;
  priceCop: number | null;
  points: ScrapedPickupPoint[];
}

// =============================================================================
// RETAILER REGISTRATION TYPES
//
// The scraper is built around a small registry of retailers (see RETAILERS
// in the service). Each entry carries:
//   - the hostnames it owns (e.g. ['alkosto.com', 'ktronix.com.co'])
//   - a static-HTML parser (cheerio over the bare-curl response)
//   - an optional render config used when the static parse comes back
//     empty (typical for SPAs that hydrate their store list)
//
// To onboard a new retailer, write a parser + render config and append
// to RETAILERS — no changes to the scraping pipeline itself.
// =============================================================================

interface RetailerConfig {
  hostMatches: string[];
  parseStatic: (url: string, domain: string, html: string) => ScrapedSourceResult;
  render?: RetailerRenderConfig;
}

interface RetailerRenderConfig {
  /** Where to centre the headless browser's geolocation. Most LATAM
   *  retailers gate their store list on geo so we pin a sensible
   *  default per retailer. */
  geolocation: { latitude: number; longitude: number };
  /** Optional cheap pre-filter to skip JSON responses from URLs that
   *  obviously aren't the store list (saves JSON-parse cost). */
  urlMatcher?: RegExp;
  /** Decide which rows of an intercepted JSON payload look like the
   *  retailer's store list. Returns [] for irrelevant payloads. */
  extractRows: (body: unknown) => unknown[];
  /** Stable dedup key per row (often a store id / cross / sku). Empty
   *  string means "don't dedup, accept every occurrence". */
  rowKey: (row: unknown) => string;
  /** Map a captured raw JSON row into the storage shape. Receives the
   *  scraper instance so it can reuse city/title-case helpers. Return
   *  null to drop a malformed row. */
  mapRow: (row: unknown, ctx: RetailScraperHelpers) => ScrapedPickupPoint | null;
  /** CSS selectors clicked inside the rendered page if no XHR fires
   *  on its own (some retailers gate the store list on a tab click). */
  clickSelectors: string[];
  /** Where to read the price from the rendered DOM. Both selectors
   *  optional — leave undefined when a retailer doesn't expose price
   *  on the PDP at all. */
  price: { hiddenSelector?: string; textSelector?: string };
}

/** Subset of the service exposed to per-retailer mappers, so we don't
 *  hand them the whole NestJS instance. */
export interface RetailScraperHelpers {
  publicNormaliseCity(raw: string): string;
  publicPrettyCity(raw: string): string;
  publicTitleCase(s: string): string;
}

// -------------------------------------------------------------------
// HYBRIS-FAMILY RENDER CONFIG (Alkosto + Ktronix today)
//
// SAP Hybris-based retailers share a public-facing JSON shape:
//   { data: [{ name, displayName, line1, line2, cityName,
//              stockPickup, cross, latitude, longitude, openings, … }] }
// stockPickup is human-readable Spanish ("Hay 5 unidades" / "Sin
// existencias") — the only stable signal is the first integer.
// -------------------------------------------------------------------
type HybrisStoreRow = {
  name?: string;
  displayName?: string;
  line1?: string;
  line2?: string;
  cityName?: string;
  formattedDistance?: string;
  stockPickup?: string;
  cross?: string | number;
  latitude?: number;
  longitude?: number;
  openings?: Record<string, string>;
};

const ALKOSTO_RENDER_CONFIG: RetailerRenderConfig = {
  geolocation: { latitude: 4.7110, longitude: -74.0721 }, // Bogotá centre
  urlMatcher: /store|pickup|pos|availab/i,
  extractRows: (body) => {
    const data = (body as { data?: unknown })?.data;
    if (!Array.isArray(data)) return [];
    return data.filter((r) => {
      if (!r || typeof r !== 'object') return false;
      const row = r as HybrisStoreRow;
      return !!(row.displayName || row.name);
    });
  },
  rowKey: (row) => {
    const r = row as HybrisStoreRow;
    return String(r.cross ?? r.name ?? r.displayName ?? '');
  },
  mapRow: (row, ctx) => {
    const r = row as HybrisStoreRow;
    const stockMatch = (r.stockPickup ?? '').match(/(\d+)/);
    const stockUnits = stockMatch ? Math.max(0, parseInt(stockMatch[1], 10)) : 0;
    const cityRaw = (r.cityName ?? '').trim();
    const addressLine = [r.line1, r.line2].filter(Boolean).join(' ').trim() || null;
    const name = (r.displayName ?? r.name ?? '').trim();
    if (!name) return null;
    return {
      externalId: r.cross != null ? String(r.cross) : null,
      name: ctx.publicTitleCase(name),
      address: addressLine,
      city: ctx.publicNormaliseCity(cityRaw || name),
      cityDisplay: ctx.publicPrettyCity(cityRaw || name),
      lat: typeof r.latitude === 'number' ? r.latitude : null,
      lng: typeof r.longitude === 'number' ? r.longitude : null,
      hours: r.openings
        ? Object.entries(r.openings).map(([d, t]) => `${d}: ${t}`).join(' · ')
        : null,
      stockUnits,
    };
  },
  clickSelectors: [
    '.js-pickup-in-store-button',
    '.js-pickup-button',
    '.js-pickup-in-store-modal',
    '[data-test="pickup-store"]',
  ],
  price: { hiddenSelector: 'input.price-hidden', textSelector: '#js-original_price' },
};

/**
 * Pulls inventory + pricing snapshots from public retailer product
 * pages. Domain-specific parsers live as private methods — the public
 * `fetch()` dispatches on hostname so adding a new retailer is just
 * "add a parser". Today we cover alkosto.com (which also serves
 * ktronix.com.co since their store list is shared); other domains
 * fall through to a "no support" result with a clear error message.
 *
 * Anti-fragility:
 *   - Realistic User-Agent so the page doesn't get bot-blocked
 *   - 10s timeout — we'd rather miss a refresh than hang the cron
 *   - Every parser wraps individual store reads in try/catch so a
 *     single malformed entry doesn't drop the rest of the cities
 *   - Returns `null` for missing data (price, stock) rather than
 *     fabricating zero — the dashboard distinguishes the two
 */
@Injectable()
export class RetailScraperService {
  private readonly logger = new Logger(RetailScraperService.name);

  // Realistic UA. We set this so the retailer's WAF / CDN treats us as
  // a real browser — Cloudflare's bot challenge will block plain Node
  // user-agents, and an empty UA gets a 403 from many e-commerce sites.
  private readonly UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

  // -------------------------------------------------------------------
  // RETAILER REGISTRY
  //
  // Each supported retailer registers a config: the hostnames it owns,
  // the cheap static-HTML parser to try first, and the puppeteer
  // fallback config used when the static parse comes back empty
  // (typically because the retailer migrated to a SPA that loads its
  // store list via XHR after hydration).
  //
  // Adding a new retailer (e.g. Falabella, Homecenter, Easy):
  //   1. Write a `parseFooHtml(url, domain, html)` method that returns
  //      ScrapedSourceResult for the static-HTML case.
  //   2. Optionally provide a `RetailerRenderConfig` with a JSON
  //      payload matcher + row mapper for the SPA fallback.
  //   3. Append an entry to RETAILERS below. No other code changes.
  //
  // The puppeteer machinery (`renderAndCaptureStores`) is fully
  // retailer-agnostic — it just takes the config and runs.
  // -------------------------------------------------------------------
  private readonly RETAILERS: RetailerConfig[] = [
    {
      hostMatches: ['alkosto.com', 'ktronix.com.co'],
      // Both share the same SAP Hybris storefront, so the static parser
      // and SPA mapper are identical.
      parseStatic: (url, domain, html) => this.parseAlkosto(url, domain, html),
      render: ALKOSTO_RENDER_CONFIG,
    },
    // Future:
    //   { hostMatches: ['homecenter.com.co'], parseStatic: …, render: … },
  ];

  // -------------------------------------------------------------------
  // Public entry: fetch + parse a single product URL.
  //
  // Strategy is the same for every retailer:
  //   1. Try the cheap static HTML parse first. If the retailer ships
  //      SSR'd store data, we never pay browser cost.
  //   2. If static returns 0 points, fall back to a puppeteer render
  //      that intercepts the JSON the SPA frontend fetches. JSON shape
  //      is structurally more stable than the HTML.
  // -------------------------------------------------------------------
  async fetch(url: string): Promise<ScrapedSourceResult> {
    const domain = this.normaliseDomain(url);
    if (!domain) throw new Error(`URL inválida: ${url}`);

    const retailer = this.RETAILERS.find((r) =>
      r.hostMatches.some((h) => domain.endsWith(h)),
    );
    if (!retailer) {
      const supported = this.RETAILERS.flatMap((r) => r.hostMatches).join(', ');
      throw new Error(
        `Aún no soportamos ${domain}. Por ahora aceptamos enlaces de ${supported}.`,
      );
    }

    const html = await this.fetchHtml(url);
    const cheap = retailer.parseStatic(url, domain, html);
    if (cheap.points.length > 0) return cheap;
    // Static parse returned no points — likely a SPA that hydrates
    // its store list. Use the per-retailer render config (if any) to
    // open the PDP in a browser and intercept the XHR.
    if (!retailer.render) return cheap;
    this.logger.log(`Static HTML had 0 stores for ${url} — falling back to puppeteer render`);
    return this.renderAndCaptureStores(url, domain, cheap.priceCop, retailer.render);
  }

  // -------------------------------------------------------------------
  // ALKOSTO + KTRONIX (shared store layout)
  //
  // Price (resolved order):
  //   1. <input class="price-hidden" value="637425.0">  (canonical)
  //   2. text inside #js-original_price ("$637.425")    (fallback)
  //
  // Stores: each `.js-store-box` carries data attributes
  //   data-city       — pretty city name ("Bogota", "Medellin")
  //   data-name       — store name in lowercase ("alkosto av. 30")
  //   data-stock      — integer count (0 = sin stock)
  //   data-distance   — "8.254 Km" — captured but not stored
  // Inside each box:
  //   .store-title  — proper-cased store name
  //   .store-address
  //   .opening      — "Abierto de 08:00 am a 10:00 pm"
  //   <a> with maps URL containing "?api=1&query=lat,lng"
  //   for ID we extract from the input id "AKB30-availability" → "AKB30"
  // -------------------------------------------------------------------
  private parseAlkosto(url: string, domain: string, html: string): ScrapedSourceResult {
    const $ = cheerio.load(html);

    // ── Price ───────────────────────────────────────────────────────
    let priceCop: number | null = null;
    const hidden = $('input.price-hidden').first().attr('value');
    if (hidden) {
      const n = parseFloat(hidden);
      if (Number.isFinite(n) && n > 0) priceCop = Math.round(n);
    }
    if (priceCop === null) {
      const textPrice = $('#js-original_price').first().text();
      const m = textPrice.match(/\$\s*([\d.,]+)/);
      if (m) {
        // Colombian format: "$637.425" — periods are thousands separators.
        const digits = m[1].replace(/[.,]/g, '');
        const n = parseInt(digits, 10);
        if (Number.isFinite(n) && n > 0) priceCop = n;
      }
    }

    // ── Pickup points ───────────────────────────────────────────────
    const points: ScrapedPickupPoint[] = [];
    $('.js-store-box').each((_, el) => {
      try {
        const $el = $(el);
        const cityRaw  = ($el.attr('data-city') || '').trim();
        const stockStr = ($el.attr('data-stock') || '').trim();
        const stockUnits = Math.max(0, parseInt(stockStr, 10) || 0);
        const titleEl = $el.find('.store-title').first();
        const name = titleEl.text().trim() || ($el.attr('data-name') || '').trim();
        if (!name || !cityRaw) return; // skip malformed rows

        const address = $el.find('.store-address').first().text().trim() || null;
        const hours   = $el.find('.opening').first().text().trim() || null;

        // External id — the form input id is like "AKB30-availability".
        // Some rows also carry it on a label[for=…].
        let externalId: string | null = null;
        const labelFor = $el.find('label.click-label').first().attr('for');
        if (labelFor && labelFor.endsWith('-availability')) {
          externalId = labelFor.slice(0, -'-availability'.length);
        }

        // Geo from the maps anchor's query string
        let lat: number | null = null;
        let lng: number | null = null;
        const mapHref = $el.find('a.map-text').first().attr('href') || '';
        const geoMatch = mapHref.match(/[?&]query=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
        if (geoMatch) {
          const la = parseFloat(geoMatch[1]);
          const ln = parseFloat(geoMatch[2]);
          // Sanity-check Colombian lat/lng range so a malformed value
          // doesn't insert (-9.9k, -7.5k) into the DB.
          if (la >= -5 && la <= 14 && ln >= -82 && ln <= -66) {
            lat = la; lng = ln;
          }
        }

        points.push({
          externalId,
          name: this.titleCase(name),
          address,
          city: this.normaliseCity(cityRaw),
          cityDisplay: this.prettyCity(cityRaw),
          lat, lng, hours,
          stockUnits,
        });
      } catch (err) {
        this.logger.warn(`alkosto store parse failed: ${(err as Error).message}`);
      }
    });

    return { url, domain, priceCop, points };
  }

  // -------------------------------------------------------------------
  // GENERIC SPA SCRAPER
  //
  // Retailer-agnostic puppeteer pipeline used as the fallback path when
  // the cheap static-HTML parse comes back empty (which is the common
  // case for any modern SPA storefront). The retailer-specific bits
  // — what the JSON looks like, which DOM button forces the XHR, how
  // to read the price — all come from the `RetailerRenderConfig`
  // passed in. The browser machinery itself doesn't know or care
  // which retailer it's pointed at.
  //
  // Flow:
  //   1. Launch headless Chromium with the stealth plugin so bot
  //      challenges (Cloudflare, Akamai, etc.) don't trip.
  //   2. Pin the configured geolocation so the SPA doesn't sit on a
  //      permission prompt waiting for coordinates.
  //   3. Subscribe to every JSON response. For each one, the retailer's
  //      `extractRows()` decides whether the payload is the store list
  //      (typically by shape match: `{ data: [...] }` of objects with
  //      a recognisable field). Captured rows are deduped by id.
  //   4. Open the page, wait for the auto-fire window, then click the
  //      retailer's pickup-store CTA (if configured) to force the XHR.
  //   5. Read the price from the rendered DOM via the retailer's price
  //      selectors.
  //   6. Hand each captured row to the retailer's `mapRow()` to convert
  //      it into the storage-shape ScrapedPickupPoint.
  // -------------------------------------------------------------------
  private async renderAndCaptureStores(
    url: string,
    domain: string,
    fallbackPrice: number | null,
    cfg: RetailerRenderConfig,
  ): Promise<ScrapedSourceResult> {
    let browser: Browser | null = null;
    try {
      browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--lang=es-CO',
        ],
      }) as unknown as Browser;
      const ctx = browser.defaultBrowserContext();
      try {
        const origin = new URL(url).origin;
        await ctx.overridePermissions(origin, ['geolocation']);
      } catch { /* ignore — flow still works without geolocation */ }
      const page: Page = await browser.newPage();
      await page.setUserAgent(this.UA);
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'es-CO,es;q=0.9' });
      await page.setGeolocation(cfg.geolocation);

      const collected: unknown[] = [];
      const seen = new Set<string>();
      page.on('response', async (resp: HTTPResponse) => {
        try {
          if (!/json/i.test(resp.headers()['content-type'] ?? '')) return;
          if (cfg.urlMatcher && !cfg.urlMatcher.test(resp.url())) return;
          const body = (await resp.json()) as unknown;
          const rows = cfg.extractRows(body);
          for (const row of rows) {
            const key = cfg.rowKey(row);
            if (key && seen.has(key)) continue;
            if (key) seen.add(key);
            collected.push(row);
          }
        } catch { /* not JSON or shape mismatch — skip */ }
      });

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      // Auto-fire window: many SPAs trigger the store XHR after geo
      // resolves, with no user interaction required.
      await new Promise((r) => setTimeout(r, 3000));
      // If nothing fired, click the retailer's pickup CTA to force it.
      if (collected.length === 0 && cfg.clickSelectors.length > 0) {
        try {
          await page.evaluate((sel: string) => {
            const btn = document.querySelector(sel) as HTMLElement | null;
            if (btn) btn.click();
          }, cfg.clickSelectors.join(', '));
          for (let i = 0; i < 16 && collected.length === 0; i++) {
            await new Promise((r) => setTimeout(r, 500));
          }
        } catch { /* ignore */ }
      }

      const priceCop = await page.evaluate((priceCfg) => {
        // Hidden input first (machine-readable, no formatting noise).
        if (priceCfg.hiddenSelector) {
          const el = document.querySelector(priceCfg.hiddenSelector) as HTMLInputElement | null;
          if (el?.value) {
            const n = parseFloat(el.value);
            if (Number.isFinite(n) && n > 0) return Math.round(n);
          }
        }
        // Then text fallback — strip thousands separators, parse digits.
        if (priceCfg.textSelector) {
          const txt = document.querySelector(priceCfg.textSelector)?.textContent ?? '';
          const m = txt.match(/\$\s*([\d.,]+)/);
          if (m) {
            const digits = m[1].replace(/[.,]/g, '');
            const n = parseInt(digits, 10);
            if (Number.isFinite(n) && n > 0) return n;
          }
        }
        return null;
      }, cfg.price).catch(() => null);

      const points: ScrapedPickupPoint[] = collected
        .map((r) => cfg.mapRow(r, this))
        .filter((p): p is ScrapedPickupPoint => !!p && !!p.name);

      this.logger.log(`Rendered ${url}: ${points.length} stores parsed`);
      return { url, domain, priceCop: priceCop ?? fallbackPrice, points };
    } finally {
      if (browser) {
        await browser.close().catch(() => { /* nothing useful to recover */ });
      }
    }
  }

  // Public exposure of the city normalisers so per-retailer mappers
  // (declared at module scope) can reuse them.
  publicNormaliseCity(raw: string): string  { return this.normaliseCity(raw); }
  publicPrettyCity(raw: string): string     { return this.prettyCity(raw); }
  publicTitleCase(s: string): string        { return this.titleCase(s); }

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------

  private async fetchHtml(url: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent':      this.UA,
          'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'es-CO,es;q=0.9,en;q=0.8',
          'Cache-Control':   'no-cache',
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`Retailer respondió ${res.status} ${res.statusText}`);
      }
      const ctype = res.headers.get('content-type') ?? '';
      if (!ctype.includes('text/html')) {
        throw new Error(`Respuesta no es HTML (content-type: ${ctype || 'desconocido'})`);
      }
      return await res.text();
    } finally {
      clearTimeout(timeout);
    }
  }

  private normaliseDomain(url: string): string | null {
    try {
      const u = new URL(url);
      // Drop "www." prefix so domain matching is consistent.
      return u.hostname.replace(/^www\./i, '').toLowerCase();
    } catch {
      return null;
    }
  }

  /** "Bogota" → "bogota". Strip accents + lowercase. Used as the
   *  city join key — the buyer-facing UI groups points by it. */
  private normaliseCity(raw: string): string {
    return raw.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, '-')
      .trim();
  }

  /** "bogota" / "Bogota" → "Bogotá" when we can map it. Falls back to
   *  title-casing the raw input. Adding a city: append below. */
  private prettyCity(raw: string): string {
    const t = raw.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    const map: Record<string, string> = {
      bogota: 'Bogotá',          medellin: 'Medellín',
      cali: 'Cali',              barranquilla: 'Barranquilla',
      cartagena: 'Cartagena',    bucaramanga: 'Bucaramanga',
      cucuta: 'Cúcuta',          pereira: 'Pereira',
      manizales: 'Manizales',    armenia: 'Armenia',
      ibague: 'Ibagué',          neiva: 'Neiva',
      popayan: 'Popayán',        'santa-marta': 'Santa Marta',
      villavicencio: 'Villavicencio',
      monteria: 'Montería',      sincelejo: 'Sincelejo',
      tunja: 'Tunja',            valledupar: 'Valledupar',
      yopal: 'Yopal',            mosquera: 'Mosquera',
      chia: 'Chía',              fusagasuga: 'Fusagasugá',
      girardot: 'Girardot',      apartado: 'Apartadó',
      barrancabermeja: 'Barrancabermeja',
      bello: 'Bello',            cartago: 'Cartago',
      piedecuesta: 'Piedecuesta', rionegro: 'Rionegro',
      sabaneta: 'Sabaneta',
    };
    return map[t] ?? this.titleCase(raw);
  }

  private titleCase(s: string): string {
    return s
      .toLowerCase()
      .replace(/\b([a-záéíóúñü])/g, (m) => m.toUpperCase())
      .trim();
  }
}
