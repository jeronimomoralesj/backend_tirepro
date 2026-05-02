import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Distributor-facing analytics. Every metric here is computed from
 * authoritative tables (MarketplaceOrder, MarketplaceView,
 * DistributorListing) — no estimates, no extrapolation. If we don't
 * have data for a metric, we return 0 / [] rather than fabricating a
 * value, so the dashboard never lies to a distributor.
 *
 * Revenue-style metrics filter on `paymentStatus = 'approved'` AND
 * `status != 'cancelado'` so a cancelled-but-paid order doesn't
 * inflate top-line numbers. AOV uses the same denominator, so it
 * remains internally consistent.
 */
@Injectable()
export class MarketplaceStatsService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Returns a Date `days` days ago at 00:00:00 UTC — the standard cutoff
   *  for windowed metrics. UTC because Postgres stores timestamps in UTC
   *  by default and we don't want DST surprises. */
  private daysAgo(days: number): Date {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - days);
    return d;
  }

  /** Standard "this order counts as revenue" filter. Approved payment
   *  AND not cancelled. Reused in every revenue/AOV/top-product query
   *  so the dashboard stays internally consistent. */
  private revenueFilter(distributorId: string, since?: Date) {
    return {
      distributorId,
      paymentStatus: 'approved',
      status: { not: 'cancelado' },
      ...(since ? { createdAt: { gte: since } } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // Overview — single payload covering everything the stats page needs
  //
  // Returns:
  //   ordersByStatus   — raw counts per status string, all-time
  //   revenue          — { today, last7, last30, mtd, ytd } in COP
  //   aov              — average order value, last 30d window only
  //   ordersCount      — { last7, last30 } counts of qualifying orders
  //   topProducts      — top 10 SKUs by units sold in the last `days`
  //   profileViews     — { last7, last30 } counts of distributor-page views
  //   topViewedProducts— top 10 product listings by view count in last `days`
  // ---------------------------------------------------------------------------
  async overview(distributorId: string, days: number = 30) {
    if (!distributorId) throw new BadRequestException('distributorId required');
    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);
    const cutoff7   = this.daysAgo(7);
    const cutoff30  = this.daysAgo(30);
    const cutoffWin = this.daysAgo(days);
    const startOfMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const startOfYear  = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));

    // ── 1. Orders by status — raw counts, no filter on payment so the
    //       dist sees the actual operational queue (incl. unpaid pending).
    const statusCounts = await this.prisma.marketplaceOrder.groupBy({
      by: ['status'],
      where: { distributorId },
      _count: { _all: true },
    });
    const ordersByStatus: Record<string, number> = {
      pendiente: 0, confirmado: 0, enviado: 0, entregado: 0, cancelado: 0,
    };
    for (const r of statusCounts) {
      ordersByStatus[r.status] = r._count._all;
    }

    // ── 2. Revenue + order counts in 5 windows. We hit the DB once per
    //       window — Prisma's aggregate is cheap on the indexed
    //       (distributorId, status) and (createdAt) indexes the orders
    //       table already carries.
    const aggWindow = (since: Date) =>
      this.prisma.marketplaceOrder.aggregate({
        where: this.revenueFilter(distributorId, since),
        _sum:   { totalCop: true },
        _count: { _all: true },
      });
    const aggAll = () =>
      this.prisma.marketplaceOrder.aggregate({
        where: this.revenueFilter(distributorId),
        _sum:   { totalCop: true },
        _count: { _all: true },
      });

    const [aToday, a7, a30, aMtd, aYtd, aAll] = await Promise.all([
      aggWindow(startOfToday),
      aggWindow(cutoff7),
      aggWindow(cutoff30),
      aggWindow(startOfMonth),
      aggWindow(startOfYear),
      aggAll(),
    ]);

    const revenue = {
      today: aToday._sum.totalCop ?? 0,
      last7: a7._sum.totalCop ?? 0,
      last30: a30._sum.totalCop ?? 0,
      mtd:   aMtd._sum.totalCop ?? 0,
      ytd:   aYtd._sum.totalCop ?? 0,
      allTime: aAll._sum.totalCop ?? 0,
    };
    const ordersCount = {
      today: aToday._count._all,
      last7: a7._count._all,
      last30: a30._count._all,
    };
    // AOV computed from the 30-day window — gives a meaningful denominator
    // (most dists won't have enough orders today for daily AOV). Returns
    // 0 when no orders so the UI can hide the metric cleanly.
    const aov = a30._count._all > 0
      ? Math.round((a30._sum.totalCop ?? 0) / a30._count._all)
      : 0;

    // ── 3. Top products by units sold in the windowed period.
    //       Group MarketplaceOrder by listingId, sum quantity, sort.
    const topProductRows = await this.prisma.marketplaceOrder.groupBy({
      by: ['listingId'],
      where: this.revenueFilter(distributorId, cutoffWin),
      _sum:   { quantity: true, totalCop: true },
      _count: { _all: true },
    });
    // Sort + slice in-memory; groupBy doesn't support orderBy on _sum
    // reliably across Prisma versions, and the result set is naturally
    // bounded by the dist's catalog size.
    const topListingIds = topProductRows
      .sort((a, b) => (b._sum.quantity ?? 0) - (a._sum.quantity ?? 0))
      .slice(0, 10)
      .map((r) => r.listingId);
    const topListingMeta = topListingIds.length > 0
      ? await this.prisma.distributorListing.findMany({
          where:  { id: { in: topListingIds } },
          select: { id: true, marca: true, modelo: true, dimension: true, imageUrls: true, coverIndex: true, precioCop: true },
        })
      : [];
    const topListingMap = new Map(topListingMeta.map((l) => [l.id, l]));
    const topProducts = topProductRows
      .sort((a, b) => (b._sum.quantity ?? 0) - (a._sum.quantity ?? 0))
      .slice(0, 10)
      .map((r) => {
        const meta = topListingMap.get(r.listingId);
        return {
          listingId: r.listingId,
          marca:     meta?.marca ?? '—',
          modelo:    meta?.modelo ?? '—',
          dimension: meta?.dimension ?? '—',
          imageUrl:  this.coverImage(meta?.imageUrls as any, meta?.coverIndex ?? 0),
          unitsSold: r._sum.quantity ?? 0,
          revenue:   r._sum.totalCop ?? 0,
          orderCount: r._count._all,
        };
      });

    // ── 4. Distributor profile-page views in 7d / 30d.
    const [v7, v30] = await Promise.all([
      this.prisma.marketplaceView.count({
        where: { distributorId, targetType: 'distributor', createdAt: { gte: cutoff7 } },
      }),
      this.prisma.marketplaceView.count({
        where: { distributorId, targetType: 'distributor', createdAt: { gte: cutoff30 } },
      }),
    ]);

    // ── 5. Top viewed products in the windowed period.
    const topViewRows = await this.prisma.marketplaceView.groupBy({
      by: ['targetId'],
      where: { distributorId, targetType: 'product', createdAt: { gte: cutoffWin } },
      _count: { _all: true },
    });
    const topViewIds = topViewRows
      .sort((a, b) => b._count._all - a._count._all)
      .slice(0, 10)
      .map((r) => r.targetId);
    const topViewMeta = topViewIds.length > 0
      ? await this.prisma.distributorListing.findMany({
          where:  { id: { in: topViewIds } },
          select: { id: true, marca: true, modelo: true, dimension: true, imageUrls: true, coverIndex: true, precioCop: true },
        })
      : [];
    const topViewMap = new Map(topViewMeta.map((l) => [l.id, l]));
    const topViewedProducts = topViewRows
      .sort((a, b) => b._count._all - a._count._all)
      .slice(0, 10)
      .map((r) => {
        const meta = topViewMap.get(r.targetId);
        return {
          listingId: r.targetId,
          marca:     meta?.marca ?? '—',
          modelo:    meta?.modelo ?? '—',
          dimension: meta?.dimension ?? '—',
          imageUrl:  this.coverImage(meta?.imageUrls as any, meta?.coverIndex ?? 0),
          views:     r._count._all,
        };
      })
      // Drop any rows whose listing was deleted from the catalog —
      // we don't want to show a phantom "—" product to the dist.
      .filter((r) => r.marca !== '—');

    return {
      windowDays: days,
      ordersByStatus,
      revenue,
      ordersCount,
      aov,
      topProducts,
      profileViews: { last7: v7, last30: v30 },
      topViewedProducts,
    };
  }

  // ---------------------------------------------------------------------------
  // Per-product detail. Verifies the listing belongs to the asking
  // distributor (404 otherwise — we never leak another company's data).
  //
  // Returns:
  //   listing       — { id, marca, modelo, dimension, precioCop, imageUrl }
  //   totalViews    — count over the window
  //   viewsByDay    — array of { date: 'YYYY-MM-DD', count } for sparkline
  //   viewsByCity   — top 10 cities (excluding null)
  //   viewsByCountry— top 5 countries
  //   ordersFromViews — orders this listing got in the same period (real,
  //                     not "of viewers who ordered")
  //   conversionPct — orders / views, only when views > 0
  // ---------------------------------------------------------------------------
  async productDetail(distributorId: string, listingId: string, days: number = 30) {
    if (!distributorId) throw new BadRequestException('distributorId required');
    if (!listingId)     throw new BadRequestException('listingId required');

    // Authorise — the listing must belong to this distributor.
    const listing = await this.prisma.distributorListing.findUnique({
      where: { id: listingId },
      select: {
        id: true, marca: true, modelo: true, dimension: true, precioCop: true,
        imageUrls: true, coverIndex: true, distributorId: true,
        cantidadDisponible: true, isActive: true,
      },
    });
    if (!listing) throw new NotFoundException('Listing not found');
    if (listing.distributorId !== distributorId) {
      throw new NotFoundException('Listing not found');
    }

    const cutoff = this.daysAgo(days);

    // Single SELECT for views (we'll bucket by day client-side from a
    // raw query for efficiency). Use $queryRaw for date_trunc — Prisma's
    // groupBy doesn't support DATE truncation directly.
    const [totalViews, cityRows, countryRows, dailyRows, ordersFromViews] = await Promise.all([
      this.prisma.marketplaceView.count({
        where: { targetType: 'product', targetId: listingId, createdAt: { gte: cutoff } },
      }),
      this.prisma.marketplaceView.groupBy({
        by: ['city'],
        where: { targetType: 'product', targetId: listingId, createdAt: { gte: cutoff }, city: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.marketplaceView.groupBy({
        by: ['country'],
        where: { targetType: 'product', targetId: listingId, createdAt: { gte: cutoff }, country: { not: null } },
        _count: { _all: true },
      }),
      // Day-level bucketing in raw SQL — we want a `YYYY-MM-DD` key per
      // day in the window even when the day has zero views, but the
      // empty-day fill happens client-side. Here we just return what
      // the DB has, in chronological order.
      this.prisma.$queryRaw<{ day: Date; count: bigint }[]>`
        SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::bigint AS count
        FROM "marketplace_views"
        WHERE "targetType" = 'product'
          AND "targetId" = ${listingId}
          AND "createdAt" >= ${cutoff}
        GROUP BY day
        ORDER BY day ASC
      `,
      this.prisma.marketplaceOrder.count({
        where: { ...this.revenueFilter(distributorId, cutoff), listingId },
      }),
    ]);

    const viewsByCity = cityRows
      .sort((a, b) => b._count._all - a._count._all)
      .slice(0, 10)
      .map((r) => ({ city: r.city ?? '—', count: r._count._all }));
    const viewsByCountry = countryRows
      .sort((a, b) => b._count._all - a._count._all)
      .slice(0, 5)
      .map((r) => ({ country: r.country ?? '—', count: r._count._all }));

    const viewsByDay = dailyRows.map((r) => ({
      date: r.day.toISOString().slice(0, 10),
      count: Number(r.count),
    }));

    const conversionPct = totalViews > 0
      ? Math.round((ordersFromViews / totalViews) * 1000) / 10  // one decimal
      : null;

    return {
      windowDays: days,
      listing: {
        id: listing.id,
        marca: listing.marca,
        modelo: listing.modelo,
        dimension: listing.dimension,
        precioCop: listing.precioCop,
        imageUrl: this.coverImage(listing.imageUrls as any, listing.coverIndex),
        cantidadDisponible: listing.cantidadDisponible,
        isActive: listing.isActive,
      },
      totalViews,
      viewsByDay,
      viewsByCity,
      viewsByCountry,
      ordersFromViews,
      conversionPct,
    };
  }

  // ---------------------------------------------------------------------------
  // Track a view event. Called by the public POST /marketplace/track/view
  // endpoint. Fire-and-forget — caller doesn't wait on persistence.
  //
  // For product views we resolve `distributorId` from the listing.
  // For distributor views, distributorId == targetId. If the listing
  // doesn't exist we silently no-op (don't 404 a tracking call —
  // it's a public endpoint and we don't want to leak listing IDs).
  // ---------------------------------------------------------------------------
  // Filtered out before persistence so the dist's "vistas" number
  // means "real humans + AI/search assistants browsing the page",
  // not "every crawler that hits a URL". Lowercase substring match
  // is enough — UAs are wildly inconsistent and any bot serious
  // enough to spoof its UA would also spoof a different one.
  //
  // Note: GPTBot / ClaudeBot / PerplexityBot are intentionally NOT
  // here. We DO want their visits counted because that's what
  // proves a dist's storefront is being cited by AI engines —
  // that's a signal the dist will care about. The list below is
  // pure crawl-budget-burning noise (search-engine indexers,
  // SEO scanners, link checkers).
  private readonly BOT_UA_FRAGMENTS = [
    'googlebot', 'bingbot', 'yandexbot', 'duckduckbot', 'slurp',
    'baiduspider', 'sogou', 'exabot',
    'ahrefsbot', 'semrushbot', 'mj12bot', 'dotbot', 'blexbot',
    'screaming frog', 'pingdom', 'lighthouse', 'pagespeed', 'gtmetrix',
    'headlesschrome', 'phantomjs', 'puppeteer', 'playwright',
    'curl/', 'wget/', 'python-requests', 'go-http-client', 'okhttp',
  ];
  private isBotUserAgent(ua: string | null | undefined): boolean {
    if (!ua) return true; // No UA at all is itself suspicious.
    const lower = ua.toLowerCase();
    return this.BOT_UA_FRAGMENTS.some((f) => lower.includes(f));
  }

  async recordView(input: {
    targetType: 'product' | 'distributor';
    targetId: string;
    userId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
    country?: string | null;
    region?: string | null;
    city?: string | null;
  }): Promise<void> {
    const { targetType, targetId } = input;
    if (targetType !== 'product' && targetType !== 'distributor') return;
    if (!targetId) return;
    // Drop bot/crawler hits before they touch the DB. Distributor's
    // analytics card has to mean something — if a curl hits the page
    // it shouldn't show up as a "view".
    if (this.isBotUserAgent(input.userAgent)) return;

    let distributorId: string | null = null;
    if (targetType === 'product') {
      const l = await this.prisma.distributorListing.findUnique({
        where:  { id: targetId },
        select: { distributorId: true },
      });
      if (!l) return;
      distributorId = l.distributorId;
    } else {
      const c = await this.prisma.company.findUnique({
        where: { id: targetId }, select: { id: true },
      });
      if (!c) return;
      distributorId = c.id;
    }
    if (!distributorId) return;

    try {
      await this.prisma.marketplaceView.create({
        data: {
          targetType,
          targetId,
          distributorId,
          userId:    input.userId    ?? null,
          ip:        input.ip        ?? null,
          userAgent: input.userAgent ?? null,
          country:   input.country   ?? null,
          region:    input.region    ?? null,
          city:      input.city      ?? null,
        },
      });
    } catch (e) {
      // Tracking is best-effort — never let a write failure surface
      // to the user. Log and move on.
      console.warn('[marketplace-stats] view write failed:', (e as Error).message);
    }
  }

  // ---------------------------------------------------------------------------
  // Cover-image extraction shared by overview + productDetail. The
  // listing schema stores imageUrls as Json (string[]) with a separate
  // coverIndex int. Defensive against legacy rows where imageUrls
  // could be null or non-array.
  // ---------------------------------------------------------------------------
  private coverImage(imageUrls: unknown, coverIndex: number): string | null {
    if (!Array.isArray(imageUrls) || imageUrls.length === 0) return null;
    const idx = coverIndex >= 0 && coverIndex < imageUrls.length ? coverIndex : 0;
    const u = imageUrls[idx];
    return typeof u === 'string' && u.length > 0 ? u : null;
  }
}
