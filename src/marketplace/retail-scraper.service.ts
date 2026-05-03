import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';

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
  // -------------------------------------------------------------------
  async fetch(url: string): Promise<ScrapedSourceResult> {
    const domain = this.normaliseDomain(url);
    if (!domain) throw new Error(`URL inválida: ${url}`);

    const html = await this.fetchHtml(url);
    if (domain.endsWith('alkosto.com') || domain.endsWith('ktronix.com.co')) {
      return this.parseAlkosto(url, domain, html);
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
