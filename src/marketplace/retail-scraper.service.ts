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
  // Public entry: fetch + parse a single product URL.
  //
  // Alkosto / Ktronix migrated to a SPA-style PDP where the store list
  // (the bit we actually care about) is loaded via XHR after the page
  // hydrates. The plain-curl HTML now contains zero `js-store-box`
  // elements, so the legacy parser silently returned 0 stock for
  // every bodega — the bug the user reported.
  //
  // Strategy:
  //   1. Try the cheap static HTML parser first. If the retailer
  //      ever ships SSR'd store data again (or for sites that still
  //      do), we don't pay the puppeteer cost.
  //   2. If the static parse returns 0 points, fall back to a
  //      puppeteer-extra render: open the page, set a Bogotá
  //      geolocation, intercept the XHR JSON the frontend fires for
  //      store availability, and parse THAT directly. JSON is
  //      structurally stable across HTML refactors.
  // -------------------------------------------------------------------
  async fetch(url: string): Promise<ScrapedSourceResult> {
    const domain = this.normaliseDomain(url);
    if (!domain) throw new Error(`URL inválida: ${url}`);

    if (domain.endsWith('alkosto.com') || domain.endsWith('ktronix.com.co')) {
      const html = await this.fetchHtml(url);
      const cheap = this.parseAlkosto(url, domain, html);
      if (cheap.points.length > 0) return cheap;
      // Cheap parser saw no stores — the SPA hydration kicks in here.
      this.logger.log(`Static HTML had 0 stores for ${url} — falling back to puppeteer render`);
      return this.fetchAlkostoRendered(url, domain, cheap.priceCop);
    }
    // Unknown domain — return enough of a shell so the admin UI can
    // tell the dist "we don't have a parser for this site yet" rather
    // than crashing.
    throw new Error(
      `Aún no soportamos ${domain}. Por ahora aceptamos enlaces de alkosto.com y ktronix.com.co.`,
    );
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
  // ALKOSTO RENDERED — puppeteer fallback when the static HTML returns
  // 0 stores (which is now the default since their PDP started loading
  // the store list via XHR after hydration).
  //
  // We intercept the JSON the frontend receives instead of scraping the
  // rendered DOM — the JSON shape is more stable than the HTML and
  // tells us per-bodega stock directly. The flow:
  //
  //   1. Launch puppeteer-extra (headless + stealth so Cloudflare /
  //      Akamai bot challenges don't trip).
  //   2. Pin Bogotá geolocation so the SPA doesn't sit on a permission
  //      prompt waiting for coordinates.
  //   3. Listen on every response for the store-pickup JSON. Alkosto
  //      paginates this — we accumulate everything that looks like a
  //      `data: [...stores...]` payload.
  //   4. Open the page, then click the "Recoger en tienda" button to
  //      force the XHR (some flows auto-fire after geolocation, others
  //      need the click). Either path adds to the same accumulator.
  //   5. Map the captured JSON into the same ScrapedPickupPoint shape
  //      the static parser produced — so the writer logic in
  //      retail-source.service.ts doesn't change.
  // -------------------------------------------------------------------
  private async fetchAlkostoRendered(
    url: string,
    domain: string,
    fallbackPrice: number | null,
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
        // Permit geolocation so the SPA doesn't ask + skip rendering
        // the list. Origin must match the page; we strip query+hash.
        const origin = new URL(url).origin;
        await ctx.overridePermissions(origin, ['geolocation']);
      } catch { /* ignore — fallback flow still works */ }
      const page: Page = await browser.newPage();
      await page.setUserAgent(this.UA);
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'es-CO,es;q=0.9' });
      // Bogotá city centre — far enough into Colombia that every
      // bodega Alkosto serves shows up in the list (the API returns
      // them regardless of distance, but a real lat/lng makes the
      // request look like a typical browser session).
      await page.setGeolocation({ latitude: 4.7110, longitude: -74.0721 });

      // Accumulate every JSON response that looks like a store payload.
      // Alkosto's URL templates change occasionally, so we filter on
      // payload shape (data array of objects with displayName/stockPickup)
      // instead of URL pattern.
      type RawStore = {
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
        url?: string;
        openings?: Record<string, string>;
        productcode?: string;
      };
      const stores: RawStore[] = [];
      const seenCross = new Set<string>();
      page.on('response', async (resp: HTTPResponse) => {
        try {
          const respUrl = resp.url();
          // Cheap pre-filter so we don't try to JSON-parse every PNG.
          if (!/json/i.test(resp.headers()['content-type'] ?? '')) return;
          if (!/store|pickup|pos|availab/i.test(respUrl)) return;
          const body = (await resp.json()) as unknown;
          const data = (body as { data?: unknown })?.data;
          if (!Array.isArray(data)) return;
          for (const row of data) {
            if (!row || typeof row !== 'object') continue;
            const r = row as RawStore;
            if (!r.displayName && !r.name) continue;
            const key = String(r.cross ?? r.name ?? r.displayName ?? '');
            if (seenCross.has(key)) continue;
            seenCross.add(key);
            stores.push(r);
          }
        } catch {
          /* not JSON, or shape mismatch — skip silently */
        }
      });

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      // Give the SPA a moment to hydrate + auto-fire the store fetch.
      await new Promise((r) => setTimeout(r, 3000));
      // If nothing showed up yet, click the pickup-in-store CTA so the
      // XHR fires. Wrapped in try because the selector occasionally
      // changes; a missing button isn't fatal — many flows already fired.
      if (stores.length === 0) {
        try {
          await page.evaluate(() => {
            const sel = [
              '.js-pickup-in-store-button',
              '.js-pickup-button',
              '.js-pickup-in-store-modal',
              '[data-test="pickup-store"]',
            ].join(', ');
            const btn = document.querySelector(sel) as HTMLElement | null;
            if (btn) btn.click();
          });
          // Wait up to 8s for the XHR to land.
          for (let i = 0; i < 16 && stores.length === 0; i++) {
            await new Promise((r) => setTimeout(r, 500));
          }
        } catch { /* ignore */ }
      }

      // Resolve price from rendered DOM (the rendered page is the most
      // reliable place to read it — Alkosto sometimes A/B-tests the
      // hidden input out).
      const priceCop = await page.evaluate(() => {
        const input = document.querySelector('input.price-hidden') as HTMLInputElement | null;
        if (input?.value) {
          const n = parseFloat(input.value);
          if (Number.isFinite(n) && n > 0) return Math.round(n);
        }
        const txt = document.querySelector('#js-original_price')?.textContent ?? '';
        const m = txt.match(/\$\s*([\d.,]+)/);
        if (m) {
          const digits = m[1].replace(/[.,]/g, '');
          const n = parseInt(digits, 10);
          if (Number.isFinite(n) && n > 0) return n;
        }
        return null;
      }).catch(() => null);

      // Map raw rows → ScrapedPickupPoint. stockPickup is a Spanish
      // string like "Hay 5 unidades" / "5 unidades disponibles" /
      // "Sin existencias" — the only stable signal is the first
      // integer in the text (presence ⇒ stock>0; absence ⇒ stock=0).
      const points: ScrapedPickupPoint[] = stores.map((r) => {
        const stockMatch = (r.stockPickup ?? '').match(/(\d+)/);
        const stockUnits = stockMatch ? Math.max(0, parseInt(stockMatch[1], 10)) : 0;
        const cityRaw = (r.cityName ?? '').trim();
        const addressLine = [r.line1, r.line2].filter(Boolean).join(' ').trim() || null;
        return {
          externalId: r.cross != null ? String(r.cross) : null,
          name: this.titleCase((r.displayName ?? r.name ?? '').trim()),
          address: addressLine,
          city: this.normaliseCity(cityRaw || (r.displayName ?? '')),
          cityDisplay: this.prettyCity(cityRaw || (r.displayName ?? '')),
          lat: typeof r.latitude === 'number' ? r.latitude : null,
          lng: typeof r.longitude === 'number' ? r.longitude : null,
          hours: r.openings ? Object.entries(r.openings).map(([d, t]) => `${d}: ${t}`).join(' · ') : null,
          stockUnits,
        };
      }).filter((p) => p.name);

      this.logger.log(`Puppeteer render for ${url}: ${points.length} stores parsed`);
      return { url, domain, priceCop: priceCop ?? fallbackPrice, points };
    } finally {
      if (browser) {
        await browser.close().catch(() => { /* nothing useful to recover */ });
      }
    }
  }

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
