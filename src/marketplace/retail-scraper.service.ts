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
  /** Selector that signals "the store list is fully rendered in the
   *  DOM". After clicking the pickup CTA the scraper waits for this
   *  before sampling the page HTML. Optional — not every retailer
   *  builds the list directly into the DOM (some only respond to the
   *  XHR interception path). */
  storeListSelector?: string;
  /**
   * Fallback path: parse the post-hydration HTML with the same parser
   * that handles the static SSR case. The Alkosto family in particular
   * doesn't fire an XHR on the PDP — the SPA pulls the store data once
   * at boot and renders it directly into the modal. So when JSON
   * interception comes back empty, we hand the rendered HTML to this
   * parser to extract the store list from the DOM. Optional — leave
   * undefined for retailers that genuinely only expose stock via XHR.
   */
  parseRenderedHtml?: (url: string, domain: string, html: string) => ScrapedSourceResult;
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
  // Modal trigger selectors confirmed against the actual Alkosto PDP
  // HTML (8807622212017). Tried in order, every match clicked. The
  // visible CTA is the anchor; the LI is the tab variant; the wrapper
  // divs are kept as fallbacks because the SPA reshuffles them
  // periodically.
  clickSelectors: [
    '.js-pickup-in-store-modal-label',
    '.js-open-modal-PDP-components[data-id="store-availability"]',
    '.js-delivery-pickup-selection',
    '.AddToCart-PickUpInStoreAction',
    '.js-pickup-in-store-modal',
    '.js-pickup-in-store-button',
    '.js-pickup-button',
  ],
  // Wait for the post-hydration store list to appear in the modal —
  // each entry is a `.js-store-box` with `data-stock` / `data-city`
  // attributes the static parser already knows how to read.
  storeListSelector: '.js-store-box',
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
      // and SPA mapper are identical. The render config also reuses the
      // static parser as its DOM fallback (parseRenderedHtml) — Alkosto
      // PDPs render the store list directly into the modal HTML on
      // hydration, so the post-render `page.content()` looks exactly
      // like the SSR'd version this parser was originally written for.
      parseStatic: (url, domain, html) => this.parseAlkosto(url, domain, html),
      render: {
        ...ALKOSTO_RENDER_CONFIG,
        parseRenderedHtml: (url, domain, html) => this.parseAlkosto(url, domain, html),
      },
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
    // Diagnostic counters so the logs reveal which signal we ended up
    // believing for each scrape — useful when Alkosto changes the
    // attribute model again.
    let textWins = 0, attrWins = 0, agree = 0;
    $('.js-store-box').each((_, el) => {
      try {
        const $el = $(el);
        const cityRaw  = ($el.attr('data-city') || '').trim();
        const titleEl = $el.find('.store-title').first();
        const name = titleEl.text().trim() || ($el.attr('data-name') || '').trim();
        if (!name || !cityRaw) return; // skip malformed rows

        // Stock has two surfaces:
        //   1. data-stock attribute on the .js-store-box wrapper.
        //   2. .store-stock text node ("2 Unidades disponibles" /
        //      "No hay unidades disponibles").
        // The user reported every store reading "30 u." even when the
        // visible text said "2" — turns out Alkosto's PDP renders a
        // skeleton with data-stock="30" then loads real stock only
        // into the text. So we trust the text first; data-stock is a
        // fallback when the .store-stock node is missing entirely.
        const stockEl = $el.find('.store-stock').first();
        const stockText = stockEl.text().trim();
        const hasAvailableMarker = stockEl.hasClass('available');
        const hasNoStockText = /no hay unidades|sin existencias|sin stock/i.test(stockText);
        let stockFromText: number | null = null;
        if (hasNoStockText) {
          stockFromText = 0;
        } else if (stockText) {
          const m = stockText.match(/(\d+)/);
          if (m) stockFromText = parseInt(m[1], 10);
          // If no digit but the .available class is on, treat as ≥1
          // so the buyer at least sees the bodega in the picker.
          else if (hasAvailableMarker) stockFromText = 1;
        }

        const attrStr = ($el.attr('data-stock') || '').trim();
        const stockFromAttr = attrStr ? parseInt(attrStr, 10) : null;

        let stockUnits: number;
        if (stockFromText != null && stockFromAttr != null) {
          if (stockFromText === stockFromAttr) {
            agree++;
            stockUnits = stockFromText;
          } else {
            // Disagreement — text wins (it's what the buyer actually
            // sees). The Alkosto skeleton bug is the canonical case.
            textWins++;
            stockUnits = stockFromText;
          }
        } else if (stockFromText != null) {
          stockUnits = stockFromText;
        } else if (stockFromAttr != null) {
          attrWins++;
          stockUnits = stockFromAttr;
        } else {
          stockUnits = 0;
        }
        stockUnits = Math.max(0, stockUnits);

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

    if (textWins + attrWins + agree > 0) {
      this.logger.log(
        `alkosto stock signal: ${agree} agree · ${textWins} text-wins · ${attrWins} attr-only`,
      );
    }

    // Dedupe — defence in depth. Some renders (modal re-opens, multiple
    // city tabs visible at once, partial-fragment swaps) can land the
    // same store-box more than once in the DOM. Prefer the row with the
    // higher stockUnits when an externalId collides; fall back to name
    // when externalId is null.
    const dedup = new Map<string, ScrapedPickupPoint>();
    for (const p of points) {
      const key = (p.externalId ?? p.name).toLowerCase().trim();
      const existing = dedup.get(key);
      if (!existing || p.stockUnits > existing.stockUnits) {
        dedup.set(key, p);
      }
    }
    return { url, domain, priceCop, points: Array.from(dedup.values()) };
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
      // Auto-fire window: let the SPA hydrate.
      await new Promise((r) => setTimeout(r, 3000));

      // Click the FIRST matching pickup CTA only. Some retailer modals
      // (Alkosto's included) re-render the store list every time the
      // open-modal trigger fires — clicking 4 different triggers in
      // sequence appended the list 4 times, producing the inflated
      // ~3.7x duplicates the user saw (184 stores instead of ~50).
      const clickReport = await page.evaluate((selectors: string[]) => {
        for (const sel of selectors) {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (el) {
            try { el.click(); } catch { /* ignore */ }
            return { matched: sel, tried: selectors };
          }
        }
        return { matched: null as string | null, tried: selectors };
      }, cfg.clickSelectors).catch(() => ({ matched: null as string | null, tried: cfg.clickSelectors }));

      if (clickReport.matched) {
        this.logger.log(`Clicked pickup CTA: ${clickReport.matched}`);
      } else if (cfg.clickSelectors.length > 0) {
        this.logger.warn(`No pickup CTA matched for ${url}. Tried: ${cfg.clickSelectors.join(', ')}`);
      }

      // Wait for the rendered store list (selector configured per retailer)
      // OR for the JSON interception to land — whichever comes first.
      if (cfg.storeListSelector) {
        try {
          await page.waitForSelector(cfg.storeListSelector, { timeout: 15_000 });
          // Give the modal a beat to fully populate after the first
          // .js-store-box appears (Alkosto streams them in groups).
          await new Promise((r) => setTimeout(r, 1500));
        } catch {
          this.logger.warn(`Timed out waiting for ${cfg.storeListSelector} on ${url}`);
        }
      } else {
        for (let i = 0; i < 16 && collected.length === 0; i++) {
          await new Promise((r) => setTimeout(r, 500));
        }
      }

      // Diagnostic: how many candidate elements actually rendered?
      if (cfg.storeListSelector) {
        const inDom = await page.evaluate(
          (sel) => document.querySelectorAll(sel).length,
          cfg.storeListSelector,
        ).catch(() => 0);
        this.logger.log(`${cfg.storeListSelector} count in DOM: ${inDom}`);
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

      let points: ScrapedPickupPoint[] = collected
        .map((r) => cfg.mapRow(r, this))
        .filter((p): p is ScrapedPickupPoint => !!p && !!p.name);
      let source: 'json' | 'dom' | 'none' = points.length > 0 ? 'json' : 'none';

      // Fallback: the SPA may have rendered the store list straight into
      // the DOM (Alkosto's PDP does exactly this — no XHR fires for the
      // store data, the modal just opens with everything pre-rendered).
      // Sample the post-hydration HTML and reuse the static parser.
      if (points.length === 0 && cfg.parseRenderedHtml) {
        try {
          const html = await page.content();
          const fromDom = cfg.parseRenderedHtml(url, domain, html);
          if (fromDom.points.length > 0) {
            points = fromDom.points;
            source = 'dom';
          }
        } catch (err) {
          this.logger.warn(`DOM-fallback parse failed for ${url}: ${(err as Error).message}`);
        }
      }

      this.logger.log(`Rendered ${url}: ${points.length} stores parsed (source: ${source})`);
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
