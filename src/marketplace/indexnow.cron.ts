// =============================================================================
// IndexNowCron — daily refresh ping for evergreen high-value URLs.
//
// Listing/blog/brand mutations already fire targeted IndexNow pings
// the moment a row changes. This cron is the safety net: once a day
// it pings the canonical landing pages (home, top brands, top
// dimensions, glossary, guías, comparativas) so Bing keeps a fresh
// index even when nothing changed in the marketplace itself.
//
// 10K URL/day quota; we ping ~150-200 high-value URLs which is well
// inside it.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { IndexNowService } from './indexnow.service';

const SITE = 'https://www.tirepro.com.co';

// Static evergreen URLs that should be re-pinged daily so Bing
// re-crawls them. Mirrors the highest-priority entries from
// frontend's sitemap.ts (priority >= 0.85).
const STATIC_URLS = [
  `${SITE}/`,
  `${SITE}/marketplace`,
  `${SITE}/marketplace/comparar`,
  `${SITE}/guias`,
  `${SITE}/glosario`,
  `${SITE}/calculadora`,
  `${SITE}/blog`,
];

@Injectable()
export class IndexNowCron {
  private readonly logger = new Logger(IndexNowCron.name);

  constructor(
    private readonly prisma:   PrismaService,
    private readonly indexNow: IndexNowService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM, { name: 'indexnow-daily-refresh', timeZone: 'America/Bogota' })
  async dailyRefresh() {
    const urls: string[] = [...STATIC_URLS];

    // Top brands by listing count (the canonical landing pages users
    // actually land on for "comprar Michelin Colombia"-style queries).
    try {
      const brands = await this.prisma.brandInfo.findMany({
        where:   { published: true },
        select:  { slug: true },
        take:    50,
      });
      for (const b of brands) {
        if (b.slug) urls.push(`${SITE}/marketplace/brand/${b.slug}`);
      }
    } catch (err) {
      this.logger.warn(`IndexNow brand fetch failed: ${err}`);
    }

    // Distributors (their public storefronts).
    try {
      const distributors = await this.prisma.company.findMany({
        where:   { isVerified: true, slug: { not: null } },
        select:  { slug: true },
        take:    50,
      });
      for (const d of distributors) {
        if (d.slug) urls.push(`${SITE}/marketplace/distributor/${d.slug}`);
      }
    } catch (err) {
      this.logger.warn(`IndexNow distributor fetch failed: ${err}`);
    }

    // Most-recently updated products (Bing prioritizes freshness).
    try {
      const recentListings = await this.prisma.distributorListing.findMany({
        where:   { isActive: true },
        select:  { id: true, marca: true, modelo: true, dimension: true },
        orderBy: { updatedAt: 'desc' },
        take:    100,
      });
      for (const l of recentListings) {
        const slug = `${l.marca}-${l.modelo}-${l.dimension}`
          .toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '');
        urls.push(`${SITE}/marketplace/product/${slug}-${l.id.slice(0, 8)}`);
      }
    } catch (err) {
      this.logger.warn(`IndexNow listings fetch failed: ${err}`);
    }

    this.logger.log(`IndexNow daily refresh: pinging ${urls.length} URLs`);
    await this.indexNow.ping(urls);
  }
}
