/**
 * Brand info scraper for TirePro Marketplace.
 *
 * Usage (one brand at a time):
 *   npx ts-node scripts/scrape-brand.ts Michelin
 *   npx ts-node scripts/scrape-brand.ts "Double Coin"
 *
 * Or scrape every distinct brand currently in the marketplace:
 *   npx ts-node scripts/scrape-brand.ts --all
 *
 * The scraper hits Wikipedia's REST API + the structured infobox via the
 * MediaWiki action=parse endpoint. Wikipedia is the most reliable, legally
 * unambiguous source for company facts (founding year, country,
 * headquarters, plants, parent company, logo). It will not fabricate values
 * — fields it can't find stay null and you can fill them by hand later in
 * the BrandInfo table.
 *
 * Field mapping:
 *   logoUrl       → page main image
 *   country       → infobox `country` / `nationality` / parsed from `headquarters`
 *   headquarters  → infobox `headquarters` / `hq_location_city`
 *   foundedYear   → first 4-digit year inside infobox `founded`
 *   website       → infobox `homepage` / `website`
 *   description   → REST `summary.extract`
 *   plants        → not on Wikipedia for most brands; left null
 *   parentCompany → infobox `parent` / `owner`
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const WIKI_BASES = [
  'https://es.wikipedia.org', // try Spanish first
  'https://en.wikipedia.org',
];

// Hand-curated tier list — applied during scrape so the brand page can show
// a Premium / Mid / Value badge. Anything not listed defaults to 'value'.
const TIERS: Record<string, 'premium' | 'mid' | 'value'> = {
  michelin: 'premium', bridgestone: 'premium', continental: 'premium',
  goodyear: 'premium', pirelli: 'premium', dunlop: 'premium',
  bfgoodrich: 'premium', firestone: 'premium',

  hankook: 'mid', yokohama: 'mid', kumho: 'mid', cooper: 'mid',
  maxxis: 'mid', toyo: 'mid', falken: 'mid', nexen: 'mid',
  general: 'mid',

  triangle: 'value', aeolus: 'value', linglong: 'value', 'double coin': 'value',
  westlake: 'value', sailun: 'value', roadmaster: 'value', windforce: 'value',
  cachland: 'value', sunfull: 'value', kapsen: 'value', techshield: 'value',
};

function tierFor(name: string): 'premium' | 'mid' | 'value' {
  return TIERS[name.toLowerCase().trim()] ?? 'value';
}

interface ScrapedBrand {
  name: string;
  slug: string;
  logoUrl: string | null;
  country: string | null;
  headquarters: string | null;
  foundedYear: number | null;
  website: string | null;
  description: string | null;
  parentCompany: string | null;
  tier: 'premium' | 'mid' | 'value';
  source: string;
  sourceUrl: string | null;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

async function fetchJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'TirePro-BrandScraper/1.0 (hola@tirepro.com.co)' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function scrape(brand: string): Promise<ScrapedBrand | null> {
  const queries = [`${brand} (empresa)`, `${brand} (company)`, `${brand} Tire`, `${brand} tires`, `${brand} llantas`, brand];
  for (const base of WIKI_BASES) {
    for (const q of queries) {
      const summary = await fetchJson(`${base}/api/rest_v1/page/summary/${encodeURIComponent(q)}`);
      if (!summary || summary.type === 'disambiguation' || !summary.title) continue;

      // Pull the raw wikitext (not parsetree XML — wikitext is what the
      // infobox regexes below expect).
      const parsed = await fetchJson(
        `${base}/w/api.php?action=parse&page=${encodeURIComponent(summary.title)}&prop=wikitext&format=json&origin=*`,
      );
      const infoboxText: string = parsed?.parse?.wikitext?.['*'] ?? '';

      // Topic filter — check the wikitext + summary, not just the summary,
      // so brands like Continental (whose Spanish lead doesn't mention
      // tires) still pass when the body of the article does.
      const blob = `${summary.extract ?? ''} ${summary.description ?? ''} ${infoboxText.slice(0, 4000)}`.toLowerCase();
      if (!/tire|tyre|llanta|neum|rubber|caucho|automot|industry\s*=\s*[^|]*tire|automotriz/.test(blob)) continue;

      const findField = (field: string): string | null => {
        const re = new RegExp(`\\|\\s*${field}[^=]*=\\s*([^|}]+)`, 'i');
        const m = infoboxText.match(re);
        return m ? m[1].replace(/<[^>]+>/g, '').replace(/\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g, '$1').trim() : null;
      };

      const founded = findField('founded') || findField('foundation') || findField('fundacion') || findField('fundación');
      const yearMatch = founded?.match(/\b(1[5-9]\d{2}|20\d{2})\b/);
      const foundedYear = yearMatch ? parseInt(yearMatch[1], 10) : null;

      const country = findField('country') || findField('origin_country') || findField('hq_location_country') || findField('pais') || findField('país');
      const headquarters = findField('hq_location') || findField('hq_location_city') || findField('headquarters') || findField('sede');
      const website = findField('website') || findField('homepage') || findField('url') || findField('sitioweb');
      const parent = findField('parent') || findField('owner') || findField('propietario') || findField('matriz');

      const sourceUrl: string | null = summary.content_urls?.desktop?.page ?? null;
      // Hard guarantee: only Wikipedia URLs are ever stored. Defensive check
      // in case REST ever returns a redirect to a non-wiki host.
      if (sourceUrl && !/^https?:\/\/[a-z]{2,3}\.wikipedia\.org\//i.test(sourceUrl)) {
        continue;
      }

      // Logo extraction. The REST summary `originalimage` is hit-or-miss
      // (often missing for Spanish company pages). Hit the action API
      // pageimages extension as a fallback — it returns the page's main
      // image which for company articles is reliably the logo.
      let logoUrl: string | null = summary.originalimage?.source ?? summary.thumbnail?.source ?? null;
      if (!logoUrl) {
        const pi = await fetchJson(
          `${base}/w/api.php?action=query&titles=${encodeURIComponent(summary.title)}&prop=pageimages&format=json&pithumbsize=400&origin=*`,
        );
        const pages = pi?.query?.pages;
        if (pages) {
          const page: any = Object.values(pages)[0];
          logoUrl = page?.thumbnail?.source ?? null;
        }
      }

      return {
        name: brand,
        slug: slugify(brand),
        logoUrl,
        country: country?.replace(/\{\{[^}]+\}\}/g, '').trim() || null,
        headquarters: headquarters?.replace(/\{\{[^}]+\}\}/g, '').trim() || null,
        foundedYear,
        website: website?.replace(/^https?:\/\//, 'https://').split(/\s/)[0] || null,
        description: summary.extract ?? null,
        parentCompany: parent?.replace(/\{\{[^}]+\}\}/g, '').trim() || null,
        tier: tierFor(brand),
        source: 'wikipedia',
        sourceUrl,
      };
    }
  }
  return null;
}

async function upsert(scraped: ScrapedBrand) {
  await prisma.brandInfo.upsert({
    where: { name: scraped.name },
    update: {
      slug: scraped.slug,
      logoUrl: scraped.logoUrl ?? undefined,
      country: scraped.country ?? undefined,
      headquarters: scraped.headquarters ?? undefined,
      foundedYear: scraped.foundedYear ?? undefined,
      website: scraped.website ?? undefined,
      description: scraped.description ?? undefined,
      parentCompany: scraped.parentCompany ?? undefined,
      tier: scraped.tier,
      source: scraped.source,
      sourceUrl: scraped.sourceUrl ?? undefined,
      lastScrapedAt: new Date(),
    },
    create: {
      name: scraped.name,
      slug: scraped.slug,
      logoUrl: scraped.logoUrl,
      country: scraped.country,
      headquarters: scraped.headquarters,
      foundedYear: scraped.foundedYear,
      website: scraped.website,
      description: scraped.description,
      parentCompany: scraped.parentCompany,
      tier: scraped.tier,
      source: scraped.source,
      sourceUrl: scraped.sourceUrl,
      lastScrapedAt: new Date(),
    },
  });
}

async function main() {
  const args = process.argv.slice(2);
  let brands: string[] = [];

  if (args[0] === '--all') {
    const rows = await prisma.distributorListing.findMany({
      where: { isActive: true, marca: { not: '' } },
      distinct: ['marca'],
      select: { marca: true },
    });
    brands = rows.map((r) => r.marca).filter(Boolean);
    console.log(`Scraping ${brands.length} brands from active listings…`);
  } else if (args.length > 0) {
    brands = [args.join(' ')];
  } else {
    console.error('Usage: npx ts-node scripts/scrape-brand.ts <BrandName>   |   --all');
    process.exit(1);
  }

  let ok = 0, miss = 0, stub = 0;
  for (const brand of brands) {
    process.stdout.write(`  ${brand} … `);
    try {
      const scraped = await scrape(brand);
      if (scraped) {
        await upsert(scraped);
        console.log(
          `ok · tier=${scraped.tier} · ${scraped.foundedYear ?? '?'} · ${scraped.country ?? '?'}\n     ${scraped.sourceUrl ?? '(no source)'}`,
        );
        ok++;
      } else {
        // No Wikipedia hit — create a stub row so the brand page still
        // exists with name + slug + tier. Operator can fill the rest by
        // hand later via SQL or admin UI.
        await upsert({
          name: brand,
          slug: slugify(brand),
          logoUrl: null,
          country: null,
          headquarters: null,
          foundedYear: null,
          website: null,
          description: null,
          parentCompany: null,
          tier: tierFor(brand),
          source: 'manual',
          sourceUrl: null,
        });
        console.log(`stub · tier=${tierFor(brand)} (no Wikipedia hit)`);
        stub++;
      }
    } catch (err) {
      console.log(`error: ${(err as Error).message}`);
      miss++;
    }
    // Be polite to Wikipedia
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`\nDone. ${ok} ok, ${stub} stub, ${miss} error.`);
  await prisma.$disconnect();
}

main();
