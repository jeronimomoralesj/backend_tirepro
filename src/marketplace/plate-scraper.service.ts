// =============================================================================
// PlateScraperService — headless-browser fallback for Colombian license
// plates that the cheap-and-fast tiers (memory cache, our fleet DB,
// plate_cache, datos.gov.co) couldn't resolve.
//
// Strategy:
//   1. Launch a single puppeteer-extra + stealth browser instance per
//      lookup. The stealth plugin masks the usual headless fingerprints
//      (`navigator.webdriver`, missing plugins array, the standard set
//      of automation hints). We do NOT pool the browser across requests
//      because plate lookups are bursty + rare; a per-request browser
//      keeps memory predictable on t3.medium.
//   2. Try a list of registered scrapers in priority order. The first
//      one that returns a non-null result wins. Each scraper handles
//      ONE source (consultadeplaca.com today; sura/falabella SOAT
//      cotizadores can be plugged in via the same interface later).
//   3. Hard-cap the entire flow at 15s. Anything longer suggests a
//      captcha wall, geo-block or DOM redesign that needs human
//      attention; we'd rather fail fast than starve the NestJS event
//      loop on EC2.
//
// Output is the same shape PlateLookupService consumes from datos.gov.co
// — marca / linea / modelo / clase / servicio — so the upstream caller
// doesn't care how we got the data.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, Page } from 'puppeteer';

// Singleton install — puppeteer-extra is module-global, so registering
// twice is a no-op but cheap to be defensive about. The retail-source
// scraper also installs StealthPlugin; both share the same instance.
puppeteer.use(StealthPlugin());

export interface ScrapedPlateInfo {
  marca?: string;
  linea?: string;
  modelo?: string; // year (Colombian convention: "modelo" = year of manufacture)
  clase?: string;  // e.g. AUTOMOVIL, CAMIONETA, MOTOCICLETA
  servicio?: string; // PARTICULAR | PUBLICO | OFICIAL
}

interface PlateScraper {
  name: string;
  scrape(page: Page, placa: string): Promise<ScrapedPlateInfo | null>;
}

const TOTAL_TIMEOUT_MS = 15_000;
const NAV_TIMEOUT_MS   = 12_000;
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

@Injectable()
export class PlateScraperService {
  private readonly logger = new Logger(PlateScraperService.name);

  // Order = priority. First scraper to return a non-null wins.
  private readonly scrapers: PlateScraper[] = [
    new ConsultaDePlacaScraper(),
    // Add SuraSoatScraper, FalabellaQuoterScraper, etc. as future tiers.
  ];

  /**
   * Headless-scrape a plate. Returns null when no source resolved it.
   * Throws only on completely unexpected errors — every per-source
   * timeout / DOM / network failure is caught and logged so the
   * orchestrator can keep trying the next scraper.
   */
  async scrapePlate(placa: string): Promise<ScrapedPlateInfo | null> {
    const normalized = placa.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!normalized) return null;

    const t0 = Date.now();
    this.logger.log(`[plate-scraper] start placa=${normalized} scrapers=${this.scrapers.map((s) => s.name).join(',')}`);

    let browser: Browser | null = null;
    const overall = new AbortController();
    const overallTimer = setTimeout(() => overall.abort(), TOTAL_TIMEOUT_MS);

    try {
      browser = (await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--lang=es-CO',
        ],
        // Don't trust the default 30s — anything longer than our
        // overall timeout is dead time the caller doesn't get back.
        timeout: NAV_TIMEOUT_MS,
      })) as unknown as Browser;
      this.logger.log(`[plate-scraper] browser launched in ${Date.now() - t0}ms`);

      for (const scraper of this.scrapers) {
        if (overall.signal.aborted) {
          this.logger.warn(`[plate-scraper] overall timeout (${TOTAL_TIMEOUT_MS}ms) reached, skipping remaining scrapers`);
          break;
        }
        const tScraper = Date.now();
        const page = await browser.newPage();
        try {
          await page.setUserAgent(USER_AGENT);
          await page.setExtraHTTPHeaders({ 'Accept-Language': 'es-CO,es;q=0.9' });
          // Block heavy resources we don't need — drops ~70% of bytes
          // and most pages still resolve to readable HTML.
          await page.setRequestInterception(true);
          page.on('request', (req) => {
            const t = req.resourceType();
            if (t === 'image' || t === 'media' || t === 'font' || t === 'stylesheet') return req.abort().catch(() => {});
            return req.continue().catch(() => {});
          });

          this.logger.log(`[plate-scraper] trying ${scraper.name} for ${normalized}`);
          const result = await scraper.scrape(page, normalized);
          const elapsed = Date.now() - tScraper;
          if (result && (result.marca || result.linea || result.modelo || result.clase)) {
            this.logger.log(
              `[plate-scraper] HIT ${scraper.name} for ${normalized} in ${elapsed}ms ` +
              `(marca=${result.marca ?? '-'} linea=${result.linea ?? '-'} modelo=${result.modelo ?? '-'} clase=${result.clase ?? '-'})`,
            );
            return result;
          }
          this.logger.warn(`[plate-scraper] MISS ${scraper.name} for ${normalized} in ${elapsed}ms (no fields extracted)`);
        } catch (err) {
          this.logger.warn(
            `[plate-scraper] ERROR ${scraper.name} for ${normalized}: ${(err as Error)?.message ?? err}`,
          );
        } finally {
          await page.close().catch(() => {});
        }
      }

      this.logger.warn(`[plate-scraper] all scrapers missed for ${normalized} after ${Date.now() - t0}ms`);
      return null;
    } catch (err) {
      this.logger.error(`[plate-scraper] browser launch FAILED for ${normalized}: ${(err as Error)?.message ?? err}`);
      return null;
    } finally {
      clearTimeout(overallTimer);
      await browser?.close().catch(() => {});
    }
  }
}

// =============================================================================
// ConsultaDePlacaScraper — targets consultadeplaca.com
//
// Approach: navigate to the search results URL with the plate as a
// query parameter, wait for the results card to render, then extract
// fields by label. Label-anchored extraction is more resilient than
// raw CSS selectors because aggregator sites tweak their markup
// frequently but rarely rename the visible Spanish labels.
// =============================================================================
class ConsultaDePlacaScraper implements PlateScraper {
  readonly name = 'consultadeplaca';

  async scrape(page: Page, placa: string): Promise<ScrapedPlateInfo | null> {
    const url = `https://consultadeplaca.com/colombia/${encodeURIComponent(placa)}`;
    const resp = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT_MS,
    });
    if (!resp || !resp.ok()) return null;

    // Wait for the results card. The site renders client-side after a
    // short query, so we give it up to 6s before giving up.
    try {
      await page.waitForFunction(
        () =>
          /marca|modelo|línea|clase|servicio/i.test(document.body.innerText),
        { timeout: 6_000 },
      );
    } catch {
      return null;
    }

    // Extract by Spanish label scan. Looks for "Marca: X" / "Modelo: X"
    // / "Línea: X" / "Clase: X" / "Servicio: X" patterns anywhere on the
    // page. Permissive on whitespace + adjacent punctuation.
    const data = await page.evaluate(() => {
      const text = document.body.innerText.replace(/\s+/g, ' ');
      const grab = (label: string): string | undefined => {
        const re = new RegExp(`${label}\\s*[:\\-]\\s*([A-Z0-9ÁÉÍÓÚÑ][A-Z0-9ÁÉÍÓÚÑ \\-/.]{1,40})`, 'i');
        const m = text.match(re);
        return m ? m[1].trim().replace(/\s+\S+:.*$/, '') : undefined;
      };
      return {
        marca:    grab('Marca'),
        linea:    grab('L[ií]nea'),
        modelo:   grab('Modelo|A[ñn]o'),
        clase:    grab('Clase|Tipo'),
        servicio: grab('Servicio'),
      };
    });

    if (!data.marca && !data.linea && !data.modelo && !data.clase) return null;
    return data;
  }
}
