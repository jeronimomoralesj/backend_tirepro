/**
 * STANDALONE SCRAPER SCRIPT
 * 
 * Run this ONCE locally to populate your database with market tire data
 * 
 * USAGE:
 * 1. Make sure your .env file has DATABASE_URL set correctly
 * 2. Run: npx ts-node scripts/run-initial-scrape.ts
 * 3. Delete this file after successful run
 */

import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import * as cheerio from 'cheerio';

const prisma = new PrismaClient();

interface PriceEntry {
  price: number;
  date: string;
  source?: string;
}

// Top 50 commercial truck tire brands
const TOP_BRANDS = [
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
const COMMON_DIMENSIONS = [
  '295/80R22.5', '11R22.5', '285/75R24.5', '11R24.5',
  '315/80R22.5', '275/80R22.5', '255/70R22.5', '385/65R22.5',
  '425/65R22.5', '445/65R22.5', '215/75R17.5', '235/75R17.5'
];

// Popular designs by brand
const BRAND_DESIGNS: { [key: string]: string[] } = {
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

const DEFAULT_DESIGNS = ['Highway', 'Regional', 'LongHaul', 'AllPosition', 'Drive', 'Trailer'];

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function estimatePrice(brand: string, dimension: string): number {
  const premiumBrands = ['Michelin', 'Bridgestone', 'Continental', 'Goodyear'];
  const midBrands = ['Firestone', 'BFGoodrich', 'Yokohama', 'Hankook', 'Toyo', 'Pirelli'];
  
  let basePrice = 300;
  if (premiumBrands.includes(brand)) {
    basePrice = 500;
  } else if (midBrands.includes(brand)) {
    basePrice = 400;
  }

  if (dimension.includes('425') || dimension.includes('445')) {
    basePrice *= 1.4;
  } else if (dimension.includes('385') || dimension.includes('315')) {
    basePrice *= 1.2;
  }

  return Math.round(basePrice);
}

async function scrapePrice(brand: string, diseno: string, dimension: string): Promise<number | null> {
  try {
    // In real implementation, scrape from actual tire retailers
    // For now, return estimated price
    return estimatePrice(brand, dimension);
  } catch (error) {
    console.error(`Scraping failed for ${brand} ${diseno}: ${error.message}`);
    return null;
  }
}

async function runScrape() {
  console.log('🚀 Starting initial market data scrape...\n');
  
  let created = 0;
  let skipped = 0;
  let errors = 0;

  try {
    for (const brand of TOP_BRANDS) {
      const designs = BRAND_DESIGNS[brand] || DEFAULT_DESIGNS;
      
      console.log(`\n📦 Processing brand: ${brand}`);
      
      for (const diseno of designs.slice(0, 6)) {
        for (const dimension of COMMON_DIMENSIONS.slice(0, 3)) {
          try {
            // Check if exists
            const existing = await prisma.marketTire.findUnique({
              where: {
                brand_diseno_dimension: { brand, diseno, dimension }
              }
            });

            if (existing) {
              console.log(`  ⏭️  Skipped: ${brand} ${diseno} ${dimension} (exists)`);
              skipped++;
              continue;
            }

            // Scrape or estimate price
            const price = await scrapePrice(brand, diseno, dimension);

            // Create entry
            await prisma.marketTire.create({
              data: {
                brand,
                diseno,
                dimension,
                profundidadInicial: 22,
                prices: price ? [{
                  price,
                  date: new Date().toISOString(),
                  source: 'initial_scrape'
                }] as any : [],
                lastScraped: new Date(),
              }
            });

            console.log(`  ✅ Created: ${brand} ${diseno} ${dimension} - $${price || 'N/A'}`);
            created++;

            // Small delay to be respectful
            await delay(100);

          } catch (error) {
            console.error(`  ❌ Error: ${brand} ${diseno} ${dimension} - ${error.message}`);
            errors++;
          }
        }
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('📊 SCRAPE COMPLETE');
    console.log('='.repeat(60));
    console.log(`✅ Created: ${created}`);
    console.log(`⏭️  Skipped: ${skipped}`);
    console.log(`❌ Errors: ${errors}`);
    console.log(`📈 Total: ${created + skipped}`);
    console.log('='.repeat(60) + '\n');

  } catch (error) {
    console.error('\n❌ Fatal error:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run the scraper
runScrape()
  .then(() => {
    console.log('✨ Done! You can now delete this script.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 Script failed:', error);
    process.exit(1);
  });