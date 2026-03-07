import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import * as cheerio from 'cheerio';
import axios from 'axios';
import {
  PriceEntry,
  TireReference,
  ScrapedTireData,
  parseJsonArray,
  toJsonValue,
} from './market-data.types';

@Injectable()
export class MarketDataService {
  private readonly logger = new Logger(MarketDataService.name);

  constructor(private prisma: PrismaService) {}

  // =============================================
  // CONSTANTS & BRAND ALIASES
  // =============================================

  /**
   * Map of normalized misspellings / abbreviations → canonical brand name.
   * Keys must be all-lowercase, no accents, no punctuation (matches normalizeForFuzzy output).
   * Add more entries here as you discover new variants in production.
   */
  private readonly BRAND_ALIASES: Record<string, string> = {
    // BFGoodrich variants
    bfg: 'BFGoodrich',
    bfgoodrich: 'BFGoodrich',
    'bf goodrich': 'BFGoodrich',
    bfgoodyear: 'BFGoodrich',

    // Michelin variants
    michelin: 'Michelin',
    michellin: 'Michelin',
    micheling: 'Michelin',
    michelim: 'Michelin',
    micelin: 'Michelin',

    // Bridgestone variants
    bridgestone: 'Bridgestone',
    bridgston: 'Bridgestone',
    bridgestons: 'Bridgestone',
    bridgeston: 'Bridgestone',
    brigestone: 'Bridgestone',
    bridgestone2: 'Bridgestone',

    // Goodyear variants
    goodyear: 'Goodyear',
    'good year': 'Goodyear',
    goodyea: 'Goodyear',
    goodyer: 'Goodyear',
    goodyaer: 'Goodyear',
    'goODyear': 'Goodyear',
    godyear: 'Goodyear',
    godyer: 'Goodyear',

    // Continental variants
    continental: 'Continental',
    continetal: 'Continental',
    continenetal: 'Continental',
    conti: 'Continental',
    contl: 'Continental',
    kontinental: 'Continental',

    // Firestone variants
    firestone: 'Firestone',
    firesone: 'Firestone',
    fireston: 'Firestone',
    fierstone: 'Firestone',

    // Hankook variants
    hankook: 'Hankook',
    hancook: 'Hankook',
    hankuk: 'Hankook',
    hankoc: 'Hankook',

    // Yokohama variants
    yokohama: 'Yokohama',
    yok: 'Yokohama',
    yokohamma: 'Yokohama',
    yokoama: 'Yokohama',

    // Pirelli variants
    pirelli: 'Pirelli',
    pireli: 'Pirelli',
    pireli2: 'Pirelli',
    pirelly: 'Pirelli',

    // Dunlop variants
    dunlop: 'Dunlop',
    dunlob: 'Dunlop',
    dunlpp: 'Dunlop',

    // Kumho variants
    kumho: 'Kumho',
    kumhoo: 'Kumho',
    cumho: 'Kumho',

    // Toyo variants
    toyo: 'Toyo',
    toyoo: 'Toyo',

    // Falken variants
    falken: 'Falken',
    falcken: 'Falken',

    // Cooper variants
    cooper: 'Cooper',
    coopeer: 'Cooper',

    // Sumitomo variants
    sumitomo: 'Sumitomo',
    sumitemo: 'Sumitomo',
    sumitomoo: 'Sumitomo',

    // General variants
    general: 'General',
    generl: 'General',

    // Nexen variants
    nexen: 'Nexen',
    nexeen: 'Nexen',

    // Maxxis variants
    maxxis: 'Maxxis',
    maxis: 'Maxxis',

    // GT Radial variants
    'gt radial': 'GT Radial',
    gtradial: 'GT Radial',
    'gt-radial': 'GT Radial',
    gtradiel: 'GT Radial',

    // Sailun variants
    sailun: 'Sailun',
    saylun: 'Sailun',
    sailum: 'Sailun',

    // Double Coin variants
    'double coin': 'Double Coin',
    doublecoin: 'Double Coin',
    'doble coin': 'Double Coin',
    doblecoin: 'Double Coin',

    // Triangle variants
    triangle: 'Triangle',
    triangel: 'Triangle',
    trianglee: 'Triangle',

    // Linglong variants
    linglong: 'Linglong',
    linlong: 'Linglong',
    lingling: 'Linglong',

    // Aeolus variants
    aeolus: 'Aeolus',
    eolus: 'Aeolus',
    aelous: 'Aeolus',

    // Giti variants
    giti: 'Giti',
    giiti: 'Giti',

    // Kenda variants
    kenda: 'Kenda',
    kednda: 'Kenda',

    // Doublestar variants
    doublestar: 'Doublestar',
    'double star': 'Doublestar',
    doblestar: 'Doublestar',

    // Samson variants
    samson: 'Samson',
    sansom: 'Samson',

    // Kapsen variants
    kapsen: 'Kapsen',
    capsen: 'Kapsen',

    // Austone variants
    austone: 'Austone',
    austin: 'Austone',
  };

  // =============================================
  // STARTER FUNCTION
  // =============================================

  /**
   * Run once to populate the database with top 50 tire brands and common references.
   */
  async initialScrapeAndPopulate(): Promise<{
    success: boolean;
    tiresCreated: number;
    errors: string[];
  }> {
    this.logger.log('Starting initial tire market data scrape...');

    const errors: string[] = [];
    let tiresCreated = 0;

    const topBrands = [
      'Bridgestone', 'Michelin', 'Goodyear', 'Continental', 'Hankook',
      'Yokohama', 'Sumitomo', 'Pirelli', 'Toyo', 'Cooper',
      'BFGoodrich', 'Firestone', 'Dunlop', 'Kumho', 'Falken',
      'General', 'Uniroyal', 'Nexen', 'Maxxis', 'Nankang',
      'GT Radial', 'Sailun', 'Double Coin', 'Triangle', 'Linglong',
      'Aeolus', 'Giti', 'Wanli', 'Boto', 'Westlake',
      'Goodride', 'Roadshine', 'Sunny', 'Chaoyang', 'Kenda',
      'Roadlux', 'Roadone', 'Roadmax', 'Roadcruza', 'Roadking',
      'Doublestar', 'Advance', 'Samson', 'Annaite', 'Aeolus',
      'Austone', 'Compasal', 'Kapsen', 'Ovation', 'Zeta',
    ];

    const commonDimensions = [
      '295/80R22.5', '11R22.5', '285/75R24.5', '11R24.5',
      '315/80R22.5', '275/80R22.5', '255/70R22.5', '385/65R22.5',
      '425/65R22.5', '445/65R22.5', '215/75R17.5', '235/75R17.5',
    ];

    const brandDesigns: Record<string, string[]> = {
      Continental: ['HDR2', 'HAR3', 'HTR2', 'HSR2', 'HTC1', 'HDL2'],
      Michelin: ['XZA3', 'XDA5', 'XZE', 'X Multi D', 'X Multi Z', 'XDE2+'],
      Bridgestone: ['R268', 'R283', 'R297', 'M729', 'M726', 'R187'],
      Goodyear: ['G677', 'G399', 'G316', 'G622', 'FUEL MAX', 'KMAX'],
      Firestone: ['FS591', 'FS560', 'FS400', 'FD691', 'FT492'],
      Yokohama: ['104ZR', '703ZL', 'TY517', 'RY023', 'RY055'],
      Hankook: ['DL10', 'DL12', 'AL10', 'AH11', 'TH10'],
      Toyo: ['M144', 'M154', 'M588Z', 'M647', 'M608Z'],
      Pirelli: ['FR85', 'FR25', 'FG88', 'TH88', 'TR85'],
      BFGoodrich: ['ST230', 'DR454', 'AT463', 'DT710', 'CR960A'],
      Sumitomo: ['ST918', 'ST928', 'ST938', 'ST948', 'ST958'],
      Cooper: ['CPS-21', 'CPS-41', 'RoadMaster', 'RM220', 'RM230'],
      Dunlop: ['SP346', 'SP331', 'SP382', 'SP241', 'SP444'],
      Kumho: ['KRS02', 'KRS03', 'KRT02', 'KRD02', 'KRS50'],
      Sailun: ['S606', 'S605', 'S637', 'S696', 'S740'],
      'Double Coin': ['RT500', 'RR202', 'RR900', 'RLB490', 'RLB400'],
      Triangle: ['TR691', 'TR697', 'TR685', 'TR666', 'TR675'],
      Linglong: ['KTL200', 'KTL100', 'KTL300', 'LLF02', 'LLT200'],
    };

    const defaultDesigns = ['Highway', 'Regional', 'LongHaul', 'AllPosition', 'Drive', 'Trailer'];

    try {
      for (const brand of topBrands) {
        const designs = brandDesigns[brand] || defaultDesigns;

        for (const diseno of designs.slice(0, 6)) {
          for (const dimension of commonDimensions.slice(0, 3)) {
            try {
              const existing = await this.prisma.marketTire.findUnique({
                where: { brand_diseno_dimension: { brand, diseno, dimension } },
              });

              if (existing) {
                this.logger.log(`Tire already exists: ${brand} ${diseno} ${dimension}`);
                continue;
              }

              const scrapedData = await this.scrapeTireData(brand, diseno, dimension);

              await this.prisma.marketTire.create({
                data: {
                  brand,
                  diseno,
                  dimension,
                  profundidadInicial: scrapedData.profundidadInicial || 22,
                  prices: scrapedData.price
                    ? toJsonValue([
                        {
                          price: scrapedData.price,
                          date: new Date().toISOString(),
                          source: scrapedData.source || 'initial_scrape',
                        },
                      ])
                    : [],
                  lastScraped: new Date(),
                },
              });

              tiresCreated++;
              this.logger.log(
                `Created: ${brand} ${diseno} ${dimension} - $${scrapedData.price?.toLocaleString('es-CO') ?? 'N/A'} COP`,
              );

              await this.delay(100);
            } catch (error) {
              const msg = `Error creating ${brand} ${diseno} ${dimension}: ${error.message}`;
              this.logger.error(msg);
              errors.push(msg);
            }
          }
        }
      }

      this.logger.log(`Initial scrape completed. Created ${tiresCreated} tire entries.`);
      return { success: true, tiresCreated, errors };
    } catch (error) {
      this.logger.error('Initial scrape failed:', error);
      return { success: false, tiresCreated, errors: [...errors, error.message] };
    }
  }

  // =============================================
  // SCRAPING HELPERS
  // =============================================

  private async scrapeTireData(
    brand: string,
    diseno: string,
    dimension: string,
  ): Promise<ScrapedTireData> {
    try {
      const sources = [
        { name: 'tirehub', url: `https://www.tirehub.com/search?q=${brand}+${diseno}+${dimension}` },
        { name: 'commercialtireshop', url: `https://www.commercialtireshop.com/search?q=${brand}+${diseno}+${dimension}` },
        { name: 'tirebuyer', url: `https://www.tirebuyer.com/search?q=${brand}+${diseno}+${dimension}` },
      ];

      for (const source of sources) {
        try {
          const result = await this.scrapeFromSource(source.url, source.name, brand, diseno, dimension);
          if (result.price || result.profundidadInicial) {
            return { ...result, source: source.name };
          }
        } catch (err) {
          this.logger.warn(`Failed to scrape from ${source.name}: ${err.message}`);
        }
      }

      return this.estimateTireData(brand, dimension);
    } catch (error) {
      this.logger.error(`Scraping error for ${brand} ${diseno}: ${error.message}`);
      return this.estimateTireData(brand, dimension);
    }
  }

  private async scrapeFromSource(
    url: string,
    sourceName: string,
    brand: string,
    diseno: string,
    dimension: string,
  ): Promise<{ price?: number; profundidadInicial?: number }> {
    try {
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        timeout: 10000,
      });

      const $ = cheerio.load(response.data);

      let price: number | undefined;
      const priceSelectors = [
        '.price', '.product-price', '.item-price', '[data-price]',
        '.sale-price', '.current-price', '.price-value',
      ];

      for (const selector of priceSelectors) {
        const priceText = $(selector).first().text().trim();
        const match = priceText.match(/\$?([\d,]+\.?\d*)/);
        if (match) {
          price = parseFloat(match[1].replace(',', ''));
          if (price > 0) break;
        }
      }

      let profundidadInicial: number | undefined;
      const depthText = $('body').text();
      const depthMatch = depthText.match(/tread depth[:\s]+(\d+\.?\d*)\s*(?:mm|\/32)/i);
      if (depthMatch) {
        profundidadInicial = parseFloat(depthMatch[1]);
        if (depthMatch[0].includes('/32')) {
          profundidadInicial = (profundidadInicial / 32) * 25.4;
        }
      }

      return { price, profundidadInicial };
    } catch (error) {
      throw new Error(`Scrape failed: ${error.message}`);
    }
  }

  private estimateTireData(
    brand: string,
    dimension: string,
  ): { price?: number; profundidadInicial?: number } {
    const premiumBrands = ['Michelin', 'Bridgestone', 'Continental', 'Goodyear'];
    const midBrands = ['Firestone', 'BFGoodrich', 'Yokohama', 'Hankook', 'Toyo', 'Pirelli'];

    let basePrice = 1_600_000;
    if (premiumBrands.includes(brand)) {
      basePrice = 2_300_000;
    } else if (midBrands.includes(brand)) {
      basePrice = 2_000_000;
    }

    if (dimension.includes('425') || dimension.includes('445')) {
      basePrice *= 1.4;
    } else if (dimension.includes('385') || dimension.includes('315')) {
      basePrice *= 1.2;
    }

    return { price: Math.round(basePrice), profundidadInicial: 22 };
  }

  // =============================================
  // AVERAGES
  // =============================================

  async updateTireAverages(brand: string, diseno: string, dimension: string): Promise<void> {
    try {
      const userTires = await this.prisma.tire.findMany({
        where: {
          marca:     { equals: brand,     mode: 'insensitive' },
          diseno:    { equals: diseno,    mode: 'insensitive' },
          dimension: { equals: dimension, mode: 'insensitive' },
        },
      });

      const count = userTires.length;
      if (count === 0) {
        this.logger.log(`No user tires found for ${brand} ${diseno} ${dimension}`);
        return;
      }

      let totalCpk = 0, validCpkCount = 0;
      let totalCpt = 0, validCptCount = 0;

      for (const tire of userTires) {
        const inspecciones = Array.isArray(tire.inspecciones) ? tire.inspecciones : [];
        if (inspecciones.length === 0) continue;

        const latest = inspecciones[inspecciones.length - 1] as any;

        if (latest.cpk && latest.cpk > 0) {
          totalCpk += latest.cpk;
          validCpkCount++;
        }
        if (latest.cpt && latest.cpt > 0) {
          totalCpt += latest.cpt;
          validCptCount++;
        }
      }

      const avgCpk = validCpkCount > 0 ? totalCpk / validCpkCount : null;
      const avgCpt = validCptCount > 0 ? totalCpt / validCptCount : null;

      await this.prisma.marketTire.upsert({
        where: { brand_diseno_dimension: { brand, diseno, dimension } },
        update: { cpk: avgCpk, cpt: avgCpt, count, updatedAt: new Date() },
        create: { brand, diseno, dimension, cpk: avgCpk, cpt: avgCpt, count },
      });

      this.logger.log(
        `Updated ${brand} ${diseno} ${dimension}: CPK=${avgCpk?.toFixed(3)}, CPT=${avgCpt?.toFixed(2)}, Count=${count}`,
      );
    } catch (error) {
      this.logger.error(`Failed to update averages: ${error.message}`);
      throw error;
    }
  }

  async updateAllTireAverages(): Promise<{ updated: number; errors: string[] }> {
    const marketTires = await this.prisma.marketTire.findMany();
    let updated = 0;
    const errors: string[] = [];

    for (const tire of marketTires) {
      try {
        await this.updateTireAverages(tire.brand, tire.diseno, tire.dimension);
        updated++;
      } catch (error) {
        errors.push(`${tire.brand} ${tire.diseno} ${tire.dimension}: ${error.message}`);
      }
    }

    return { updated, errors };
  }

  // =============================================
  // QUERY HELPERS
  // =============================================

  async getTireData(marca: string, diseno: string, dimension?: string) {
    const where: any = {
      brand:  { equals: marca,  mode: 'insensitive' },
      diseno: { equals: diseno, mode: 'insensitive' },
    };
    if (dimension) {
      where.dimension = { equals: dimension, mode: 'insensitive' };
    }
    return this.prisma.marketTire.findMany({ where, orderBy: { count: 'desc' } });
  }

  async getTireByReference(brand: string, diseno: string, dimension: string) {
    return this.prisma.marketTire.findUnique({
      where: { brand_diseno_dimension: { brand, diseno, dimension } },
    });
  }

  async updateMonthlyPrice(
    brand: string,
    diseno: string,
    dimension: string,
    price: number,
  ) {
    const tire = await this.prisma.marketTire.findUnique({
      where: { brand_diseno_dimension: { brand, diseno, dimension } },
    });
    if (!tire) throw new Error('Tire not found');

    const prices = parseJsonArray<PriceEntry>(tire.prices);
    prices.push({ price, date: new Date().toISOString(), source: 'manual_update' });
    const updatedPrices = prices.slice(-10);

    return this.prisma.marketTire.update({
      where: { brand_diseno_dimension: { brand, diseno, dimension } },
      data: { prices: toJsonValue(updatedPrices), lastScraped: new Date() },
    });
  }

  async getMarketInsights() {
    const allTires = await this.prisma.marketTire.findMany({ where: { count: { gt: 0 } } });

    const totalTires = allTires.reduce((sum, t) => sum + t.count, 0);

    const tiresWithCpk = allTires.filter(t => t.cpk && t.cpk > 0);
    const avgCpk =
      tiresWithCpk.length > 0
        ? tiresWithCpk.reduce((s, t) => s + (t.cpk ?? 0), 0) / tiresWithCpk.length
        : 0;

    const tiresWithCpt = allTires.filter(t => t.cpt && t.cpt > 0);
    const avgCpt =
      tiresWithCpt.length > 0
        ? tiresWithCpt.reduce((s, t) => s + (t.cpt ?? 0), 0) / tiresWithCpt.length
        : 0;

    const brandCounts = allTires.reduce(
      (acc, tire) => {
        acc[tire.brand] = (acc[tire.brand] || 0) + tire.count;
        return acc;
      },
      {} as Record<string, number>,
    );

    const topBrands = Object.entries(brandCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([brand, count]) => ({ brand, count }));

    return {
      totalTires,
      uniqueReferences: allTires.length,
      averageCpk: avgCpk,
      averageCpt: avgCpt,
      topBrands,
      tiresWithPriceData: allTires.filter(t => {
        const prices = parseJsonArray<PriceEntry>(t.prices);
        return prices && prices.length > 0;
      }).length,
    };
  }

  // =============================================
  // FUZZY MATCHING HELPERS
  // =============================================

  /**
   * Normalize for fuzzy comparison:
   * lowercase → remove accents → remove non-alphanumeric → collapse spaces
   */
  private normalizeForFuzzy(s: string): string {
    return s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private normalizeDimension(s: string): string {
    return s
      .toLowerCase()
      .replace(/-/g, '/')   // 295-80r22.5 → 295/80r22.5
      .replace(/\s+/g, '')  // remove spaces
      .trim();
  }

  /**
   * Resolve known aliases to canonical brand name before any fuzzy math.
   * e.g. "bfg" → "BFGoodrich", "good year" → "Goodyear", "goodyea" → "Goodyear"
   */
  private resolveAlias(brand: string): string {
    const key = this.normalizeForFuzzy(brand);
    return this.BRAND_ALIASES[key] ?? brand;
  }

  /**
   * Standard Levenshtein edit distance.
   */
  private levenshtein(a: string, b: string): number {
    const m = a.length, n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
      Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
    );
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] =
          a[i - 1] === b[j - 1]
            ? dp[i - 1][j - 1]
            : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
    return dp[m][n];
  }

  /**
   * Normalized distance: Levenshtein divided by the longer string's length.
   * Result is 0 (identical) → 1 (completely different).
   * Makes short and long strings comparable on the same scale.
   */
  private normalizedDistance(a: string, b: string): number {
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 0;
    return this.levenshtein(a, b) / maxLen;
  }

  /**
   * Token-set distance: splits both strings into sorted tokens, joins them,
   * then compares. Handles "GT Radial" ↔ "gtradial", "Double Coin" ↔ "doublecoin".
   */
  private tokenSetDistance(a: string, b: string): number {
    const ta = a.split(' ').sort().join('');
    const tb = b.split(' ').sort().join('');
    return this.normalizedDistance(ta, tb);
  }

  /**
   * Returns true if one string is a prefix of the other with at least minLen chars.
   * Catches truncated input: "goodyea" → "goodyear", "bridgest" → "bridgestone".
   */
  private isPrefixMatch(a: string, b: string, minLen = 5): boolean {
    if (a.length < minLen || b.length < minLen) return false;
    const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
    return longer.startsWith(shorter);
  }

  /**
   * Composite brand similarity score (lower = better match).
   *
   * Combines:
   *  - Normalized Levenshtein distance
   *  - Token-set distance (for spaced/concatenated multi-word brands)
   *  - Prefix bonus (−0.10 when one is a prefix of the other)
   *
   * Takes the minimum of the two distance strategies so multi-word brands
   * and typo-heavy single-word brands are both handled well.
   */
  private brandSimilarity(raw: string, candidate: string): number {
    const a = this.normalizeForFuzzy(raw);
    const b = this.normalizeForFuzzy(candidate);

    if (a === b) return 0;

    const normDist  = this.normalizedDistance(a, b);
    const tokenDist = this.tokenSetDistance(a, b);
    const prefix    = this.isPrefixMatch(a, b) ? -0.10 : 0;

    return Math.min(normDist, tokenDist) + prefix;
  }

  /**
   * Design similarity score (lower = better match).
   * Designs are often short alphanumeric codes ("G677", "XZA3") so we use
   * normalized Levenshtein directly — token splitting is not useful here.
   */
  private designSimilarity(raw: string, candidate: string): number {
    const a = this.normalizeForFuzzy(raw);
    const b = this.normalizeForFuzzy(candidate);
    if (a === b) return 0;
    return this.normalizedDistance(a, b);
  }

  // =============================================
  // FUZZY MARKET TIRE LOOKUP
  // =============================================

  /**
   * Find the best matching MarketTire for brand / diseno / dimension.
   *
   * Match pipeline:
   *  1. Alias resolution     — maps known misspellings/abbreviations to canonical name
   *  2. Exact DB lookup      — case-insensitive exact match (fast path)
   *  3. Fuzzy scan           — composite score below thresholds wins
   *
   * Thresholds (normalized 0–1):
   *   brandSimilarity  < 0.35  (~2 edits on "goodyear", 3 on "bridgestone")
   *   designSimilarity < 0.40  (1-2 char differences on design codes)
   *   dimension        ≤ 2 raw Levenshtein edits (separator/space differences)
   */
  async findFuzzyMarketTire(
    brand: string,
    diseno: string,
    dimension: string,
  ): Promise<{
    tire: any;
    canonicalBrand: string;
    canonicalDiseno: string;
    canonicalDimension: string;
  } | null> {
    // ── 1. Alias resolution ─────────────────────────────────────────────────
    const resolvedBrand  = this.resolveAlias(brand);
    const cleanDimension = this.normalizeDimension(dimension);

    // ── 2. Exact lookup (using resolved brand) ───────────────────────────────
    const exact = await this.prisma.marketTire.findFirst({
      where: {
        brand:     { equals: resolvedBrand, mode: 'insensitive' },
        diseno:    { equals: diseno,        mode: 'insensitive' },
        dimension: { equals: cleanDimension, mode: 'insensitive' },
      },
    });

    if (exact) {
      return {
        tire: exact,
        canonicalBrand:     exact.brand,
        canonicalDiseno:    exact.diseno,
        canonicalDimension: exact.dimension,
      };
    }

    // ── 3. Fuzzy scan ────────────────────────────────────────────────────────
    const BRAND_THRESHOLD  = 0.35;
    const DISENO_THRESHOLD = 0.40;
    const DIM_MAX_EDITS    = 2;

    const candidates = await this.prisma.marketTire.findMany();

    let bestTire:  any    = null;
    let bestScore: number = Infinity;

    for (const c of candidates) {
      // Dimension check first (cheap filter — skip obviously wrong sizes)
      const dimDist = this.levenshtein(
        this.normalizeDimension(dimension),
        this.normalizeDimension(c.dimension),
      );
      if (dimDist > DIM_MAX_EDITS) continue;

      const bScore = this.brandSimilarity(resolvedBrand, c.brand);
      if (bScore > BRAND_THRESHOLD) continue;

      const dScore = this.designSimilarity(diseno, c.diseno);
      if (dScore > DISENO_THRESHOLD) continue;

      // Weighted composite: brand matters most, then design, then dimension
      const totalScore = bScore + dScore * 0.5 + dimDist / 10;

      if (totalScore < bestScore) {
        bestScore = totalScore;
        bestTire  = c;
      }
    }

    if (bestTire) {
      this.logger.log(
        `🔍 Fuzzy match: "${brand} / ${diseno} / ${dimension}" → ` +
          `"${bestTire.brand} / ${bestTire.diseno} / ${bestTire.dimension}" ` +
          `(score ${bestScore.toFixed(3)})`,
      );
      return {
        tire: bestTire,
        canonicalBrand:     bestTire.brand,
        canonicalDiseno:    bestTire.diseno,
        canonicalDimension: bestTire.dimension,
      };
    }

    // ── No match ─────────────────────────────────────────────────────────────
    return null;
  }

  // =============================================
  // SYNC TIRE WITH MARKET DATA
  // =============================================

  /**
   * Called every time a user tire is created or imported.
   *
   * - Resolves alias first so "goodyea" never creates a duplicate entry.
   * - Fuzzy-matches against existing market tires.
   * - On match   → increments count, returns canonical names.
   * - On no match → creates new entry with clean canonical values.
   *
   * Returns canonical { brand, diseno, dimension } — always write these
   * back to the tire record so every tire in the DB uses the clean name.
   */
  async syncTireWithMarketData(
    brand: string,
    diseno: string,
    dimension: string,
  ): Promise<{
    canonicalBrand: string;
    canonicalDiseno: string;
    canonicalDimension: string;
  }> {
    try {
      const match = await this.findFuzzyMarketTire(brand, diseno, dimension);

      if (match) {
        await this.prisma.marketTire.update({
          where: { id: match.tire.id },
          data:  { count: { increment: 1 } },
        });

        this.logger.log(
          `📊 MarketTire count incremented: ${match.canonicalBrand} ${match.canonicalDiseno} ${match.canonicalDimension}`,
        );

        // Always return the CANONICAL names so the tire record stays clean
        return {
          canonicalBrand:     match.canonicalBrand,
          canonicalDiseno:    match.canonicalDiseno,
          canonicalDimension: match.canonicalDimension,
        };
      }

      // ── No match → create new entry with normalized canonical values ───────
      const resolvedBrand  = this.resolveAlias(brand);
      const cleanBrand     =
        resolvedBrand.trim().charAt(0).toUpperCase() +
        resolvedBrand.trim().slice(1);
      const cleanDiseno    = diseno.trim().toLowerCase();
      const cleanDimension = this.normalizeDimension(dimension);

      await this.prisma.marketTire.create({
        data: {
          brand:              cleanBrand,
          diseno:             cleanDiseno,
          dimension:          cleanDimension,
          profundidadInicial: 22,
          prices:             [],
          count:              1,
        },
      });

      this.logger.log(
        `✨ New MarketTire created: ${cleanBrand} ${cleanDiseno} ${cleanDimension}`,
      );

      return {
        canonicalBrand:     cleanBrand,
        canonicalDiseno:    cleanDiseno,
        canonicalDimension: cleanDimension,
      };
    } catch (error) {
      // Never block tire creation because of market data issues
      this.logger.error(`syncTireWithMarketData failed: ${error.message}`);
      return { canonicalBrand: brand, canonicalDiseno: diseno, canonicalDimension: dimension };
    }
  }

  // =============================================
  // UPDATE MARKET CPK FROM INSPECTION DATA
  // =============================================

  /**
   * Called (fire-and-forget) after every inspection save.
   * Recalculates the average cpkProyectado across all user tires matching
   * this brand/diseno/dimension and stores it on MarketTire.
   */
  async updateMarketCpkFromInspection(
    brand: string,
    diseno: string,
    dimension: string,
  ): Promise<void> {
    try {
      const match = await this.findFuzzyMarketTire(brand, diseno, dimension);
      if (!match) {
        this.logger.warn(
          `updateMarketCpk: no MarketTire found for ${brand} ${diseno} ${dimension}`,
        );
        return;
      }

      const userTires = await this.prisma.tire.findMany({
        where: {
          marca:     { equals: match.canonicalBrand,     mode: 'insensitive' },
          diseno:    { equals: match.canonicalDiseno,    mode: 'insensitive' },
          dimension: { equals: match.canonicalDimension, mode: 'insensitive' },
        },
      });

      let totalCpkProyectado = 0;
      let validCount         = 0;

      for (const tire of userTires) {
        const inspecciones = Array.isArray(tire.inspecciones)
          ? (tire.inspecciones as any[])
          : [];

        if (inspecciones.length === 0) continue;

        const latest = inspecciones[inspecciones.length - 1];
        const cpkP   = latest?.cpkProyectado;

        if (typeof cpkP === 'number' && cpkP > 0) {
          totalCpkProyectado += cpkP;
          validCount++;
        }
      }

      if (validCount === 0) {
        this.logger.log(
          `updateMarketCpk: no valid cpkProyectado yet for ${match.canonicalBrand} ${match.canonicalDiseno}`,
        );
        return;
      }

      const avgCpkProyectado = totalCpkProyectado / validCount;

      await this.prisma.marketTire.update({
        where: { id: match.tire.id },
        data:  { cpk: avgCpkProyectado, updatedAt: new Date() },
      });

      this.logger.log(
        `✅ Market CPK updated: ${match.canonicalBrand} ${match.canonicalDiseno} = ` +
          `${avgCpkProyectado.toFixed(4)} (from ${validCount} tires)`,
      );
    } catch (error) {
      this.logger.error(`updateMarketCpkFromInspection failed: ${error.message}`);
      // Never throw — inspection save must never be blocked
    }
  }

  // =============================================
  // UTILITIES
  // =============================================

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}