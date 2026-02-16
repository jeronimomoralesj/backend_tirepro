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
  toJsonValue 
} from './market-data.types';

@Injectable()
export class MarketDataService {
  private readonly logger = new Logger(MarketDataService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * STARTER FUNCTION - Run this once to populate the database
   * This will scrape the top 50 tire brands and their commercial truck tire references
   */
  async initialScrapeAndPopulate(): Promise<{ success: boolean; tiresCreated: number; errors: string[] }> {
    this.logger.log('Starting initial tire market data scrape...');
    
    const errors: string[] = [];
    let tiresCreated = 0;

    // Top 50 commercial truck tire brands (focused on transportation)
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
      'Austone', 'Compasal', 'Kapsen', 'Ovation', 'Zeta'
    ];

    // Common commercial truck tire dimensions
    const commonDimensions = [
      '295/80R22.5', '11R22.5', '285/75R24.5', '11R24.5',
      '315/80R22.5', '275/80R22.5', '255/70R22.5', '385/65R22.5',
      '425/65R22.5', '445/65R22.5', '215/75R17.5', '235/75R17.5'
    ];

    // Popular commercial tire designs by brand
    const brandDesigns: { [key: string]: string[] } = {
      'Continental': ['HDR2', 'HAR3', 'HTR2', 'HSR2', 'HTC1', 'HDL2'],
      'Michelin': ['XZA3', 'XDA5', 'XZE', 'X Multi D', 'X Multi Z', 'XDE2+'],
      'Bridgestone': ['R268', 'R283', 'R297', 'M729', 'M726', 'R187'],
      'Goodyear': ['G677', 'G399', 'G316', 'G622', 'FUEL MAX', 'KMAX'],
      'Firestone': ['FS591', 'FS560', 'FS400', 'FD691', 'FT492'],
      'Yokohama': ['104ZR', '703ZL', 'TY517', 'RY023', 'RY055'],
      'Hankook': ['DL10', 'DL12', 'AL10', 'AH11', 'TH10'],
      'Toyo': ['M144', 'M154', 'M588Z', 'M647', 'M608Z'],
      'Pirelli': ['FR85', 'FR25', 'FG88', 'TH88', 'TR85'],
      'BFGoodrich': ['ST230', 'DR454', 'AT463', 'DT710', 'CR960A'],
      'Sumitomo': ['ST918', 'ST928', 'ST938', 'ST948', 'ST958'],
      'Cooper': ['CPS-21', 'CPS-41', 'RoadMaster', 'RM220', 'RM230'],
      'Dunlop': ['SP346', 'SP331', 'SP382', 'SP241', 'SP444'],
      'Kumho': ['KRS02', 'KRS03', 'KRT02', 'KRD02', 'KRS50'],
      'Sailun': ['S606', 'S605', 'S637', 'S696', 'S740'],
      'Double Coin': ['RT500', 'RR202', 'RR900', 'RLB490', 'RLB400'],
      'Triangle': ['TR691', 'TR697', 'TR685', 'TR666', 'TR675'],
      'Linglong': ['KTL200', 'KTL100', 'KTL300', 'LLF02', 'LLT200'],
    };

    // Default designs for brands not in the map
    const defaultDesigns = ['Highway', 'Regional', 'LongHaul', 'AllPosition', 'Drive', 'Trailer'];

    try {
      for (const brand of topBrands) {
        const designs = brandDesigns[brand] || defaultDesigns;
        
        for (const diseno of designs.slice(0, 6)) { // Limit to 6 designs per brand
          for (const dimension of commonDimensions.slice(0, 3)) { // Limit to 3 dimensions per design
            try {
              // Check if tire already exists
              const existing = await this.prisma.marketTire.findUnique({
                where: {
                  brand_diseno_dimension: {
                    brand,
                    diseno,
                    dimension,
                  },
                },
              });

              if (existing) {
                this.logger.log(`Tire already exists: ${brand} ${diseno} ${dimension}`);
                continue;
              }

              // Try to scrape price and depth data
              const scrapedData = await this.scrapeTireData(brand, diseno, dimension);

              // Create the tire entry
              const tire = await this.prisma.marketTire.create({
                data: {
                  brand,
                  diseno,
                  dimension,
                  profundidadInicial: scrapedData.profundidadInicial || 22,
                  prices: scrapedData.price ? toJsonValue([
                    {
                      price: scrapedData.price,
                      date: new Date().toISOString(),
                      source: scrapedData.source || 'initial_scrape',
                    },
                  ]) : [],
                  lastScraped: new Date(),
                },
              });

              tiresCreated++;
              this.logger.log(`Created: ${brand} ${diseno} ${dimension} - $${scrapedData.price?.toLocaleString('es-CO') || 'N/A'} COP`);

              // Small delay to avoid overwhelming servers
              await this.delay(100);

            } catch (error) {
              const errorMsg = `Error creating ${brand} ${diseno} ${dimension}: ${error.message}`;
              this.logger.error(errorMsg);
              errors.push(errorMsg);
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

  /**
   * Scrape tire data from various sources
   */
  private async scrapeTireData(brand: string, diseno: string, dimension: string): Promise<ScrapedTireData> {
    try {
      // Try multiple tire retailers/sources
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

      // If scraping fails, return estimated values based on brand tier
      return this.estimateTireData(brand, dimension);

    } catch (error) {
      this.logger.error(`Scraping error for ${brand} ${diseno}: ${error.message}`);
      return this.estimateTireData(brand, dimension);
    }
  }

  /**
   * Scrape from a specific source
   */
  private async scrapeFromSource(url: string, sourceName: string, brand: string, diseno: string, dimension: string): Promise<{
    price?: number;
    profundidadInicial?: number;
  }> {
    try {
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        timeout: 10000,
      });

      const $ = cheerio.load(response.data);
      
      // Try to find price (common patterns)
      let price: number | undefined;
      const priceSelectors = [
        '.price', '.product-price', '.item-price', '[data-price]',
        '.sale-price', '.current-price', '.price-value'
      ];

      for (const selector of priceSelectors) {
        const priceText = $(selector).first().text().trim();
        const priceMatch = priceText.match(/\$?([\d,]+\.?\d*)/);
        if (priceMatch) {
          price = parseFloat(priceMatch[1].replace(',', ''));
          if (price > 0) break;
        }
      }

      // Try to find tread depth
      let profundidadInicial: number | undefined;
      const depthText = $('body').text();
      const depthMatch = depthText.match(/tread depth[:\s]+(\d+\.?\d*)\s*(?:mm|\/32)/i);
      if (depthMatch) {
        profundidadInicial = parseFloat(depthMatch[1]);
        // Convert 32nds to mm if needed
        if (depthMatch[0].includes('/32')) {
          profundidadInicial = (profundidadInicial / 32) * 25.4;
        }
      }

      return { price, profundidadInicial };

    } catch (error) {
      throw new Error(`Scrape failed: ${error.message}`);
    }
  }

  /**
   * Estimate tire data based on brand tier and dimension
   */
  private estimateTireData(brand: string, dimension: string): {
    price?: number;
    profundidadInicial?: number;
  } {
    // Brand tier pricing in COP (Colombian Pesos)
    const premiumBrands = ['Michelin', 'Bridgestone', 'Continental', 'Goodyear'];
    const midBrands = ['Firestone', 'BFGoodrich', 'Yokohama', 'Hankook', 'Toyo', 'Pirelli'];
    
    let basePrice = 1600000; // Economy default (~$300 USD at 4000 COP/USD)
    if (premiumBrands.includes(brand)) {
      basePrice = 2300000; // Premium (~$500 USD)
    } else if (midBrands.includes(brand)) {
      basePrice = 2000000; // Mid-tier (~$400 USD)
    }

    // Adjust by dimension (larger = more expensive)
    if (dimension.includes('425') || dimension.includes('445')) {
      basePrice *= 1.4;
    } else if (dimension.includes('385') || dimension.includes('315')) {
      basePrice *= 1.2;
    }

    return {
      price: Math.round(basePrice),
      profundidadInicial: 22, // Standard new truck tire depth
    };
  }

  /**
   * Update CPK and CPT averages based on actual tire data from users
   */
  async updateTireAverages(brand: string, diseno: string, dimension: string): Promise<void> {
    try {
      // Find all tires matching this reference in user data
      const userTires = await this.prisma.tire.findMany({
        where: {
          marca: { equals: brand, mode: 'insensitive' },
          diseno: { equals: diseno, mode: 'insensitive' },
          dimension: { equals: dimension, mode: 'insensitive' },
        },
      });

      const count = userTires.length;

      if (count === 0) {
        this.logger.log(`No user tires found for ${brand} ${diseno} ${dimension}`);
        return;
      }

      // Calculate average CPK
      let totalCpk = 0;
      let validCpkCount = 0;
      
      for (const tire of userTires) {
        const inspecciones = Array.isArray(tire.inspecciones) ? tire.inspecciones : [];
        if (inspecciones && inspecciones.length > 0) {
          const latestInspection = inspecciones[inspecciones.length - 1] as any;
          if (latestInspection.cpk && latestInspection.cpk > 0) {
            totalCpk += latestInspection.cpk;
            validCpkCount++;
          }
        }
      }

      const avgCpk = validCpkCount > 0 ? totalCpk / validCpkCount : null;

      // Calculate average CPT (cost per time)
      let totalCpt = 0;
      let validCptCount = 0;

      for (const tire of userTires) {
        const inspecciones = Array.isArray(tire.inspecciones) ? tire.inspecciones : [];
        if (inspecciones && inspecciones.length > 0) {
          const latestInspection = inspecciones[inspecciones.length - 1] as any;
          if (latestInspection.cpt && latestInspection.cpt > 0) {
            totalCpt += latestInspection.cpt;
            validCptCount++;
          }
        }
      }

      const avgCpt = validCptCount > 0 ? totalCpt / validCptCount : null;

      // Update or create the market tire entry
      await this.prisma.marketTire.upsert({
        where: {
          brand_diseno_dimension: { brand, diseno, dimension },
        },
        update: {
          cpk: avgCpk,
          cpt: avgCpt,
          count,
          updatedAt: new Date(),
        },
        create: {
          brand,
          diseno,
          dimension,
          cpk: avgCpk,
          cpt: avgCpt,
          count,
        },
      });

      this.logger.log(
        `Updated ${brand} ${diseno} ${dimension}: CPK=${avgCpk?.toFixed(3)}, CPT=${avgCpt?.toFixed(2)}, Count=${count}`
      );

    } catch (error) {
      this.logger.error(`Failed to update averages: ${error.message}`);
      throw error;
    }
  }

  /**
   * Update all tire averages in the system
   */
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

  /**
   * Query tire data by brand and design
   */
  async getTireData(marca: string, diseno: string, dimension?: string) {
    const where: any = {
      brand: { equals: marca, mode: 'insensitive' },
      diseno: { equals: diseno, mode: 'insensitive' },
    };

    if (dimension) {
      where.dimension = { equals: dimension, mode: 'insensitive' };
    }

    return await this.prisma.marketTire.findMany({
      where,
      orderBy: { count: 'desc' },
    });
  }

  /**
   * Get a specific tire by exact match
   */
  async getTireByReference(brand: string, diseno: string, dimension: string) {
    return await this.prisma.marketTire.findUnique({
      where: {
        brand_diseno_dimension: { brand, diseno, dimension },
      },
    });
  }

  /**
   * Update monthly prices
   */
  async updateMonthlyPrice(brand: string, diseno: string, dimension: string, price: number) {
    const tire = await this.prisma.marketTire.findUnique({
      where: {
        brand_diseno_dimension: { brand, diseno, dimension },
      },
    });

    if (!tire) {
      throw new Error('Tire not found');
    }

    // Parse existing prices
    const prices = parseJsonArray<PriceEntry>(tire.prices);
    
    // Add new price
    prices.push({
      price,
      date: new Date().toISOString(),
      source: 'manual_update',
    });

    // Keep only last 10 prices
    const updatedPrices = prices.slice(-10);

    return await this.prisma.marketTire.update({
      where: {
        brand_diseno_dimension: { brand, diseno, dimension },
      },
      data: {
        prices: toJsonValue(updatedPrices),
        lastScraped: new Date(),
      },
    });
  }

  /**
   * Get market insights
   */
  async getMarketInsights() {
    const allTires = await this.prisma.marketTire.findMany({
      where: {
        count: { gt: 0 },
      },
    });

    const totalTires = allTires.reduce((sum, tire) => sum + tire.count, 0);
    
    const tiresWithCpk = allTires.filter(t => t.cpk && t.cpk > 0);
    const avgCpk = tiresWithCpk.length > 0
      ? tiresWithCpk.reduce((sum, t) => sum + (t.cpk || 0), 0) / tiresWithCpk.length
      : 0;

    const tiresWithCpt = allTires.filter(t => t.cpt && t.cpt > 0);
    const avgCpt = tiresWithCpt.length > 0
      ? tiresWithCpt.reduce((sum, t) => sum + (t.cpt || 0), 0) / tiresWithCpt.length
      : 0;

    // Top brands by count
    const brandCounts = allTires.reduce((acc, tire) => {
      acc[tire.brand] = (acc[tire.brand] || 0) + tire.count;
      return acc;
    }, {} as Record<string, number>);

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

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}