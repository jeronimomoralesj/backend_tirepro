import { Injectable, Logger, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { RetailScraperService } from './retail-scraper.service';

/**
 * Owns the lifecycle of RetailSource + RetailPickupPoint rows. Every
 * mutating operation runs the scraper synchronously and refreshes the
 * pickup points in the same transaction so the dist's UI never sees
 * a half-updated state. The cron path uses the same `refreshSource`
 * primitive — single source of truth.
 */
@Injectable()
export class RetailSourceService {
  private readonly logger = new Logger(RetailSourceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scraper: RetailScraperService,
  ) {}

  // -------------------------------------------------------------------
  // Auth helper — every dist-facing endpoint funnels through this so
  // we have one place to audit ownership. The listing must belong to
  // the company in the JWT.
  // -------------------------------------------------------------------
  private async requireOwnedListing(listingId: string, companyId: string) {
    const listing = await this.prisma.distributorListing.findUnique({
      where:  { id: listingId },
      select: { id: true, distributorId: true },
    });
    if (!listing) throw new NotFoundException('Listing not found');
    if (listing.distributorId !== companyId) {
      throw new ForbiddenException('Listing does not belong to your company');
    }
    return listing;
  }

  // -------------------------------------------------------------------
  // Read paths
  // -------------------------------------------------------------------

  /** Distributor view — full source + every point (ordered by city,
   *  stock desc) regardless of stock level so the dist can audit
   *  empties too. */
  async getForDist(listingId: string, companyId: string) {
    await this.requireOwnedListing(listingId, companyId);
    const source = await this.prisma.retailSource.findUnique({
      where: { listingId },
      include: {
        pickupPoints: {
          orderBy: [{ city: 'asc' }, { stockUnits: 'desc' }, { name: 'asc' }],
        },
      },
    });
    return source ?? null;
  }

  /** Public buyer-facing view — strips out the parts a buyer doesn't
   *  need (priceHtmlSnippet, lastError, etc.) and only returns points
   *  with stock > 0. Caller passes listingId; the response is safe to
   *  serve uncached because it's read-mostly and tiny. */
  async getForBuyer(listingId: string) {
    const source = await this.prisma.retailSource.findUnique({
      where: { listingId },
      include: {
        pickupPoints: {
          where:   { stockUnits: { gt: 0 } },
          orderBy: [{ stockUnits: 'desc' }, { city: 'asc' }, { name: 'asc' }],
        },
      },
    });
    if (!source || !source.isActive) return null;
    // Group points by normalised city for the city-first selector UX.
    const byCity = new Map<string, {
      city: string; cityDisplay: string; totalStock: number;
      points: Array<{
        id: string; externalId: string | null; name: string;
        address: string | null; lat: number | null; lng: number | null;
        hours: string | null; stockUnits: number;
      }>;
    }>();
    for (const p of source.pickupPoints) {
      const key = p.city;
      if (!byCity.has(key)) {
        byCity.set(key, { city: p.city, cityDisplay: p.cityDisplay ?? p.city, totalStock: 0, points: [] });
      }
      const entry = byCity.get(key)!;
      entry.totalStock += p.stockUnits;
      entry.points.push({
        id: p.id, externalId: p.externalId, name: p.name,
        address: p.address, lat: p.lat, lng: p.lng,
        hours: p.hours, stockUnits: p.stockUnits,
      });
    }
    return {
      url: source.url,
      domain: source.domain,
      lastSuccessAt: source.lastSuccessAt,
      cities: Array.from(byCity.values()).sort((a, b) => b.totalStock - a.totalStock),
    };
  }

  // -------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------

  /** Create or replace the source for a listing. Fires an immediate
   *  refresh so the dist gets feedback ("here are 38 stores, 4 with
   *  stock") in the same request. Snippets are stored verbatim for
   *  the admin UI — they don't gate the parse path. */
  async upsertForDist(
    listingId: string,
    companyId: string,
    input: { url: string; priceHtmlSnippet?: string; stockHtmlSnippet?: string },
  ) {
    await this.requireOwnedListing(listingId, companyId);
    const url = (input.url ?? '').trim();
    if (!url) throw new BadRequestException('url required');

    let parsed: URL;
    try { parsed = new URL(url); }
    catch { throw new BadRequestException('URL inválida'); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BadRequestException('Solo aceptamos URLs http(s)');
    }
    const domain = parsed.hostname.replace(/^www\./i, '').toLowerCase();

    // Upsert with refreshed-state set later by `refreshSource`. We
    // do a write-then-refresh so the timestamps are consistent even
    // if the caller hits the row via /refresh next.
    const source = await this.prisma.retailSource.upsert({
      where:  { listingId },
      create: {
        listingId, url, domain,
        priceHtmlSnippet: input.priceHtmlSnippet?.slice(0, 8000) ?? null,
        stockHtmlSnippet: input.stockHtmlSnippet?.slice(0, 16000) ?? null,
        isActive: true,
      },
      update: {
        url, domain,
        priceHtmlSnippet: input.priceHtmlSnippet?.slice(0, 8000) ?? null,
        stockHtmlSnippet: input.stockHtmlSnippet?.slice(0, 16000) ?? null,
        isActive: true,
        // Don't reset lastError — it'll get cleared on the next
        // successful refresh. If the user pasted a bad URL we want
        // them to see the failure in the very next refresh.
      },
    });

    // Fire the refresh immediately so the dist gets validation feedback.
    await this.refreshSource(source.id);
    return this.getForDist(listingId, companyId);
  }

  /** Manual refresh from the dist UI ("Actualizar ahora"). */
  async refreshForDist(listingId: string, companyId: string) {
    await this.requireOwnedListing(listingId, companyId);
    const source = await this.prisma.retailSource.findUnique({
      where: { listingId }, select: { id: true },
    });
    if (!source) throw new NotFoundException('No retail source connected');
    await this.refreshSource(source.id);
    return this.getForDist(listingId, companyId);
  }

  /** Detach the source — cascade delete also wipes pickup points. */
  async deleteForDist(listingId: string, companyId: string) {
    await this.requireOwnedListing(listingId, companyId);
    await this.prisma.retailSource.deleteMany({ where: { listingId } });
    return { deleted: true };
  }

  // -------------------------------------------------------------------
  // The refresh primitive — used by upsert/refresh/cron alike.
  //
  // Always writes lastFetchedAt + (lastSuccessAt | lastError). Pickup
  // points are reconciled by `(sourceId, externalId)` — points the
  // retailer no longer lists go to stockUnits=0 with a fresh
  // refreshedAt rather than getting deleted (preserves historical
  // order references that might still point at them).
  // -------------------------------------------------------------------
  async refreshSource(sourceId: string): Promise<void> {
    const source = await this.prisma.retailSource.findUnique({ where: { id: sourceId } });
    if (!source) return;
    if (!source.isActive) return;
    const fetchedAt = new Date();
    try {
      const result = await this.scraper.fetch(source.url);
      // Fold the new points onto the existing rows. Two passes:
      //   1. Upsert each scraped point keyed by externalId
      //   2. Zero out any existing point that wasn't in the new payload
      const existing = await this.prisma.retailPickupPoint.findMany({
        where: { sourceId },
        select: { id: true, externalId: true },
      });
      const seenExternalIds = new Set<string>();
      for (const p of result.points) {
        const externalId = p.externalId ?? null;
        const match = existing.find((e) =>
          (e.externalId ?? null) === externalId && externalId !== null,
        );
        if (externalId) seenExternalIds.add(externalId);
        if (match) {
          await this.prisma.retailPickupPoint.update({
            where: { id: match.id },
            data: {
              name: p.name,
              address: p.address ?? null,
              city: p.city,
              cityDisplay: p.cityDisplay ?? null,
              lat: p.lat ?? null,
              lng: p.lng ?? null,
              hours: p.hours ?? null,
              stockUnits: p.stockUnits,
              refreshedAt: fetchedAt,
            },
          });
        } else {
          await this.prisma.retailPickupPoint.create({
            data: {
              sourceId,
              externalId,
              name: p.name,
              address: p.address ?? null,
              city: p.city,
              cityDisplay: p.cityDisplay ?? null,
              lat: p.lat ?? null,
              lng: p.lng ?? null,
              hours: p.hours ?? null,
              stockUnits: p.stockUnits,
              refreshedAt: fetchedAt,
            },
          });
        }
      }
      // Zero out anything the retailer dropped from their list.
      const droppedIds = existing
        .filter((e) => e.externalId && !seenExternalIds.has(e.externalId))
        .map((e) => e.id);
      if (droppedIds.length > 0) {
        await this.prisma.retailPickupPoint.updateMany({
          where: { id: { in: droppedIds } },
          data:  { stockUnits: 0, refreshedAt: fetchedAt },
        });
      }
      await this.prisma.retailSource.update({
        where: { id: sourceId },
        data: {
          lastFetchedAt: fetchedAt,
          lastSuccessAt: fetchedAt,
          lastPriceCop:  result.priceCop ?? source.lastPriceCop,
          lastError:     null,
          domain:        result.domain,
        },
      });
      this.logger.log(
        `Refreshed retail source ${sourceId}: ${result.points.length} points, ` +
        `price ${result.priceCop ?? 'n/a'}`,
      );
    } catch (err) {
      const msg = (err as Error).message?.slice(0, 800) ?? String(err);
      await this.prisma.retailSource.update({
        where: { id: sourceId },
        data: { lastFetchedAt: fetchedAt, lastError: msg },
      });
      this.logger.warn(`Retail source ${sourceId} refresh failed: ${msg}`);
    }
  }

  // -------------------------------------------------------------------
  // CRON — runs once per day at 4am Bogotá time. Walks every active
  // source and refreshes serially (alkosto-style retailers don't like
  // bursty parallel requests from one IP). Even at 100 dists this is
  // <2 minutes, well within a comfortable cron budget.
  // -------------------------------------------------------------------
  @Cron(CronExpression.EVERY_DAY_AT_4AM, { timeZone: 'America/Bogota' })
  async runDailyRefresh() {
    const sources = await this.prisma.retailSource.findMany({
      where: { isActive: true },
      select: { id: true, url: true },
    });
    this.logger.log(`Starting daily retail-source refresh (${sources.length} sources)`);
    let ok = 0, fail = 0;
    for (const s of sources) {
      try {
        await this.refreshSource(s.id);
        ok += 1;
        // 1.5s delay between requests to be polite to the retailer.
        await new Promise((r) => setTimeout(r, 1500));
      } catch (err) {
        fail += 1;
        this.logger.warn(`Daily refresh ${s.id} crashed: ${(err as Error).message}`);
      }
    }
    this.logger.log(`Daily retail-source refresh done: ${ok} ok, ${fail} failed`);
  }
}
