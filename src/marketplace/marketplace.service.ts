import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BidRequestStatus, BidResponseStatus, Prisma } from '@prisma/client';
import { EmailService } from '../email/email.service';
import { normalizeDimension } from '../common/normalize-dimension';

// Simple in-memory cache with TTL
class MemCache {
  private store = new Map<string, { data: any; expires: number }>();

  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry || Date.now() > entry.expires) { this.store.delete(key); return null; }
    return entry.data as T;
  }

  set(key: string, data: any, ttlMs: number) {
    this.store.set(key, { data, expires: Date.now() + ttlMs });
  }

  invalidate(prefix: string) {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  clear() { this.store.clear(); }
}

// Classic iterative Levenshtein distance — O(n*m) time, O(min(n,m)) space.
// Used for fuzzy brand matching in searchListings so typos like
// "techseled" still find "Techshield".
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Always iterate over the shorter string in the inner loop.
  if (a.length > b.length) [a, b] = [b, a];
  const prev = new Array(a.length + 1);
  const curr = new Array(a.length + 1);
  for (let i = 0; i <= a.length; i++) prev[i] = i;
  for (let j = 1; j <= b.length; j++) {
    curr[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[i] = Math.min(
        curr[i - 1] + 1,        // insertion
        prev[i] + 1,            // deletion
        prev[i - 1] + cost,     // substitution
      );
    }
    for (let i = 0; i <= a.length; i++) prev[i] = curr[i];
  }
  return prev[a.length];
}

@Injectable()
export class MarketplaceService {
  private readonly logger = new Logger(MarketplaceService.name);
  private readonly cache = new MemCache();

  // Cache TTLs
  private readonly FILTERS_TTL  = 5 * 60 * 1000;   // 5 min
  private readonly LISTINGS_TTL = 2 * 60 * 1000;   // 2 min
  private readonly PRODUCT_TTL  = 3 * 60 * 1000;   // 3 min
  private readonly RECS_TTL     = 5 * 60 * 1000;   // 5 min
  private readonly MAP_TTL      = 10 * 60 * 1000;  // 10 min
  private readonly PROFILE_TTL  = 5 * 60 * 1000;   // 5 min
  private readonly REVIEWS_TTL  = 3 * 60 * 1000;   // 3 min
  private readonly SALES_TTL    = 5 * 60 * 1000;   // 5 min

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  // ===========================================================================
  // IMAGE QUALITY SCORING
  // ===========================================================================

  async scoreImageQuality(imageUrls: string[] | null): Promise<number> {
    if (!imageUrls || imageUrls.length === 0) return 0;

    let score = 0;

    // 1. Has images at all (+20)
    score += 20;

    // 2. Multiple images show effort (+5 each, max +15)
    score += Math.min(imageUrls.length - 1, 3) * 5;

    // 3. Images from our S3 (verified uploads, not random URLs) (+15)
    const s3Count = imageUrls.filter((u) => u.includes('s3.') || u.includes('amazonaws.com')).length;
    if (s3Count > 0) score += 15;

    // 4. Check first image quality via HEAD request
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(imageUrls[0], { method: 'HEAD', signal: controller.signal });
      clearTimeout(timeout);

      if (res.ok) {
        const contentType = res.headers.get('content-type') ?? '';
        const contentLength = parseInt(res.headers.get('content-length') ?? '0', 10);

        // Proper image type (+5)
        if (contentType.startsWith('image/')) score += 5;

        // File size heuristics:
        // < 10KB = probably a thumbnail/placeholder (-10)
        // 10-50KB = low quality (+5)
        // 50-500KB = good quality (+15)
        // 500KB-2MB = high quality photo (+20)
        // > 2MB = uncompressed, possibly cluttered (+10)
        if (contentLength < 10000) score -= 10;
        else if (contentLength < 50000) score += 5;
        else if (contentLength < 500000) score += 15;
        else if (contentLength < 2000000) score += 20;
        else score += 10;

        // PNG/WebP usually cleaner product shots than JPEG with lots of compression artifacts
        if (contentType.includes('png') || contentType.includes('webp')) score += 5;
      }
    } catch {
      // Can't check = neutral
    }

    // 5. URL pattern analysis — detect likely clean product images vs cluttered marketing
    const firstUrl = imageUrls[0].toLowerCase();
    // Clean product image indicators
    if (firstUrl.includes('product') || firstUrl.includes('tire') || firstUrl.includes('llanta')) score += 5;
    // Marketing/cluttered indicators (banners, promo, logos)
    if (firstUrl.includes('banner') || firstUrl.includes('promo') || firstUrl.includes('logo') || firstUrl.includes('flyer')) score -= 10;
    // Very long query strings often = CDN marketing images with overlays
    if (firstUrl.split('?')[1]?.length > 200) score -= 5;

    return Math.max(0, Math.min(100, score));
  }

  // ===========================================================================
  // BID REQUESTS — Pro company side
  // ===========================================================================

  async createBidRequest(data: {
    companyId: string;
    items: any[];
    totalEstimado?: number;
    notas?: string;
    deliveryAddress?: string;
    deadline?: string;
    distributorIds: string[];
    isPublic?: boolean;
  }) {
    const { companyId, items, distributorIds, ...rest } = data;
    // Canonicalize dimension on each line so dist-side comparisons and
    // catalog lookups don't fail on spacing or casing drift.
    const normalizedItems = Array.isArray(items)
      ? items.map((it) => (it && typeof it === 'object' && typeof it.dimension === 'string'
          ? { ...it, dimension: normalizeDimension(it.dimension) }
          : it))
      : items;

    const bidRequest = await this.prisma.bidRequest.create({
      data: {
        companyId,
        items: normalizedItems as any,
        totalEstimado: rest.totalEstimado ?? null,
        notas: rest.notas ?? null,
        deliveryAddress: rest.deliveryAddress ?? null,
        deadline: rest.deadline ? new Date(rest.deadline) : new Date(Date.now() + 48 * 60 * 60 * 1000),
        isPublic: rest.isPublic ?? false,
        invitations: {
          create: distributorIds.map((distributorId) => ({ distributorId })),
        },
      },
      include: { invitations: true },
    });

    // Create pending BidResponse for each invited distributor
    await this.prisma.bidResponse.createMany({
      data: distributorIds.map((distributorId) => ({
        bidRequestId: bidRequest.id,
        distributorId,
      })),
    });

    return bidRequest;
  }

  async getCompanyBidRequests(companyId: string) {
    return this.prisma.bidRequest.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      include: {
        responses: {
          include: {
            distributor: { select: { id: true, slug: true, name: true, profileImage: true } },
          },
        },
        invitations: {
          include: {
            distributor: { select: { id: true, slug: true, name: true } },
          },
        },
        company: { select: { name: true } },
      },
    });
  }

  async getBidRequestById(id: string) {
    const bid = await this.prisma.bidRequest.findUnique({
      where: { id },
      include: {
        responses: {
          include: {
            distributor: { select: { id: true, slug: true, name: true, profileImage: true } },
          },
        },
        invitations: {
          include: {
            distributor: { select: { id: true, slug: true, name: true } },
          },
        },
        company: { select: { id: true, name: true } },
      },
    });
    if (!bid) throw new NotFoundException('Bid request not found');
    return bid;
  }

  async awardBid(bidRequestId: string, distributorId: string, companyId: string) {
    const bid = await this.prisma.bidRequest.findUnique({
      where: { id: bidRequestId },
      include: { responses: true },
    });
    if (!bid) throw new NotFoundException('Bid request not found');
    if (bid.companyId !== companyId) throw new BadRequestException('Not your bid request');
    if (bid.status !== BidRequestStatus.abierta) throw new BadRequestException('Bid is not open');

    const winningResponse = bid.responses.find((r) => r.distributorId === distributorId);
    if (!winningResponse || winningResponse.status !== BidResponseStatus.cotizada) {
      throw new BadRequestException('Distributor has not submitted a quote');
    }

    // Bridge from bid → purchase-order. Without this, awarding a bid only
    // flips statuses: the bid goes to `adjudicada` (which filters into the
    // dist's Completadas) and no actionable record exists for the winning
    // dist to schedule a pickup or deliver on. Creating a PurchaseOrder
    // with status=`aceptada` drops the work directly into the normal
    // pickup → entregar lifecycle, exactly as if the fleet had accepted
    // a direct cotización.
    const bidItems = Array.isArray(bid.items) ? (bid.items as any[]) : [];
    const quotes   = Array.isArray(winningResponse.cotizacion)
      ? (winningResponse.cotizacion as any[])
      : [];
    const quoteByIdx = new Map<number, any>();
    quotes.forEach((q, i) => {
      const idx = typeof q?.itemIndex === 'number' ? q.itemIndex : i;
      quoteByIdx.set(idx, q);
    });

    // Validate which tireIds in the bid still exist. A tire can be deleted
    // between bid creation and award (replaced, archived, etc.) — if we
    // try to `connect` to a missing tire, Prisma throws inside the
    // transaction and the whole award fails with a 500. Instead, we drop
    // the connect for any tire that no longer exists and let the
    // PurchaseOrderItem be created without the tire link (the marca +
    // dimension + placa fields still describe what was ordered).
    const candidateTireIds = bidItems
      .map((it) => (typeof it?.tireId === 'string' && it.tireId.length > 0 ? it.tireId : null))
      .filter((x): x is string => x !== null);
    const existingTireIds = candidateTireIds.length > 0
      ? new Set(
          (await this.prisma.tire.findMany({
            where: { id: { in: candidateTireIds } },
            select: { id: true },
          })).map((t) => t.id),
        )
      : new Set<string>();

    // Prisma's checked create input (used by nested `items: { create: [...] }`)
    // exposes `tire: { connect: { id } }` but not the scalar `tireId` — so
    // we build each row with the relation form when a tire is present.
    const poItems = bidItems.map((it, idx) => {
      const q = quoteByIdx.get(idx);
      const rawTireId = typeof it?.tireId === 'string' && it.tireId.length > 0 ? it.tireId : null;
      const tireId = rawTireId && existingTireIds.has(rawTireId) ? rawTireId : null;
      const row: any = {
        tipo:                      (it?.tipo ?? 'nueva') as string,
        marca:                     String(it?.marca ?? ''),
        modelo:                    it?.modelo ?? it?.diseno ?? it?.bandaRecomendada ?? null,
        dimension:                 typeof it?.dimension === 'string'
                                    ? normalizeDimension(it.dimension)
                                    : (it?.dimension ?? ''),
        eje:                       it?.eje ?? null,
        cantidad:                  typeof it?.cantidad === 'number' && it.cantidad > 0 ? it.cantidad : 1,
        vehiclePlaca:              it?.vehiclePlaca ?? null,
        urgency:                   it?.urgency ?? null,
        precioUnitario:            typeof q?.precioUnitario === 'number' ? q.precioUnitario : null,
        disponible:                typeof q?.disponible     === 'boolean' ? q.disponible    : null,
        tiempoEntrega:             q?.tiempoEntrega   ?? null,
        cotizacionNotas:           q?.notas           ?? null,
        bandaOfrecidaMarca:        q?.bandaOfrecidaMarca  ?? null,
        bandaOfrecidaModelo:       q?.bandaOfrecidaModelo ?? null,
        bandaOfrecidaProfundidad:  typeof q?.bandaOfrecidaProfundidad === 'number'
                                      ? q.bandaOfrecidaProfundidad
                                      : null,
        status:                    'cotizada',
      };
      if (tireId) row.tire = { connect: { id: tireId } };
      return row;
    });

    // Atomic: award winner, reject losers, close bid, create PO. We use
    // the callback form of $transaction because the array form choked on
    // the nested-create PurchaseOrder operation in this Prisma version
    // ("All elements of the array need to be Prisma Client promises").
    // Callback form runs each step sequentially inside one transaction,
    // with no PrismaPromise typing constraint.
    let createdOrder;
    try {
      createdOrder = await this.prisma.$transaction(async (tx) => {
        await tx.bidResponse.update({
          where: { id: winningResponse.id },
          data:  { status: BidResponseStatus.ganadora },
        });
        await tx.bidResponse.updateMany({
          where: { bidRequestId, id: { not: winningResponse.id } },
          data:  { status: BidResponseStatus.rechazada },
        });
        await tx.bidRequest.update({
          where: { id: bidRequestId },
          data: {
            status:     BidRequestStatus.adjudicada,
            winnerId:   distributorId,
            resolvedAt: new Date(),
          },
        });
        return tx.purchaseOrder.create({
          data: {
            companyId,
            distributorId,
            status:          'aceptada',  // fleet committed by adjudicating
            totalEstimado:   bid.totalEstimado          ?? null,
            totalCotizado:   winningResponse.totalCotizado ?? null,
            cotizacionFecha: winningResponse.submittedAt  ?? new Date(),
            cotizacionNotas: winningResponse.notas        ?? null,
            resolvedAt:      new Date(),
            resolvedBy:      companyId,
            notas:           bid.notas ?? null,
            items:           { create: poItems },
          },
        });
      });
    } catch (err: any) {
      // Surface the actual root cause to logs so future failures can be
      // diagnosed without re-deploying for instrumentation. The wrapped
      // BadRequestException keeps the HTTP response actionable for the
      // analista UI instead of a generic 500.
      // eslint-disable-next-line no-console
      console.error('[awardBid] transaction failed', {
        bidRequestId, distributorId, companyId,
        prismaCode: err?.code, message: err?.message,
        meta: err?.meta,
      });
      throw new BadRequestException(
        `No se pudo adjudicar la licitación: ${err?.message ?? 'error desconocido'}`,
      );
    }

    const out = await this.getBidRequestById(bidRequestId);
    return { ...out, purchaseOrderId: createdOrder.id };
  }

  async cancelBidRequest(bidRequestId: string, companyId: string) {
    const bid = await this.prisma.bidRequest.findUnique({ where: { id: bidRequestId } });
    if (!bid) throw new NotFoundException('Bid request not found');
    if (bid.companyId !== companyId) throw new BadRequestException('Not your bid request');

    return this.prisma.bidRequest.update({
      where: { id: bidRequestId },
      data: { status: BidRequestStatus.cancelada },
    });
  }

  // ===========================================================================
  // BID RESPONSES — Distributor side
  // ===========================================================================

  async getAvailableBids(distributorId: string) {
    return this.prisma.bidRequest.findMany({
      where: {
        status: BidRequestStatus.abierta,  // cancelled/closed already exit this set
        OR: [
          { invitations: { some: { distributorId } } },
          { isPublic: true },
        ],
        // Nothing the dist already quoted — that moves to "En Proceso" via
        // getBidsForDistributor. Keeps the sidebar + Nuevas tab count
        // scoped to fresh work.
        responses: { none: { distributorId, status: BidResponseStatus.cotizada } },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        company: { select: { id: true, name: true, profileImage: true } },
        responses: {
          where: { distributorId },
          select: { id: true, status: true, totalCotizado: true, submittedAt: true },
        },
        _count: { select: { invitations: true, responses: true } },
      },
    });
  }

  // Full bid history for a distributor — every bid where they were
  // invited, submitted a response, or won/lost. Drives the En Proceso and
  // Completadas tabs on pedidosDist (Nuevas keeps using /available so
  // fresh-work counts don't double up).
  async getBidsForDistributor(distributorId: string) {
    return this.prisma.bidRequest.findMany({
      where: {
        // Fleet cancellations disappear for every invited dist — the bid
        // is dead across the whole network, no reason to keep it visible.
        status: { not: BidRequestStatus.cancelada },
        OR: [
          { invitations: { some: { distributorId } } },
          { responses:   { some: { distributorId } } },
          { winnerId: distributorId },
          { isPublic: true },
        ],
      },
      orderBy: { createdAt: 'desc' },
      include: {
        company: { select: { id: true, name: true, profileImage: true } },
        responses: {
          where: { distributorId },
          select: { id: true, status: true, totalCotizado: true, submittedAt: true, cotizacion: true, notas: true },
        },
        _count: { select: { invitations: true, responses: true } },
      },
    });
  }

  async submitBidResponse(data: {
    bidRequestId: string;
    distributorId: string;
    cotizacion: any[];
    totalCotizado: number;
    notas?: string;
    incluyeIva?: boolean;
    tiempoEntrega?: string;
  }) {
    const bid = await this.prisma.bidRequest.findUnique({
      where: { id: data.bidRequestId },
      include: { invitations: true },
    });
    if (!bid) throw new NotFoundException('Bid request not found');
    if (bid.status !== BidRequestStatus.abierta) throw new BadRequestException('Bid is closed');
    if (bid.deadline && new Date() > bid.deadline) throw new BadRequestException('Deadline passed');

    const isInvited = bid.invitations.some((i) => i.distributorId === data.distributorId);
    if (!isInvited && !bid.isPublic) throw new BadRequestException('Not invited to this bid');

    return this.prisma.bidResponse.upsert({
      where: {
        bidRequestId_distributorId: {
          bidRequestId: data.bidRequestId,
          distributorId: data.distributorId,
        },
      },
      create: {
        bidRequestId: data.bidRequestId,
        distributorId: data.distributorId,
        status: BidResponseStatus.cotizada,
        cotizacion: data.cotizacion as any,
        totalCotizado: data.totalCotizado,
        notas: data.notas ?? null,
        incluyeIva: data.incluyeIva ?? false,
        tiempoEntrega: data.tiempoEntrega ?? null,
        submittedAt: new Date(),
      },
      update: {
        status: BidResponseStatus.cotizada,
        cotizacion: data.cotizacion as any,
        totalCotizado: data.totalCotizado,
        notas: data.notas ?? null,
        incluyeIva: data.incluyeIva ?? false,
        tiempoEntrega: data.tiempoEntrega ?? null,
        submittedAt: new Date(),
      },
    });
  }

  async rejectBidResponse(data: {
    bidRequestId: string;
    distributorId: string;
    notas?: string;
  }) {
    const bid = await this.prisma.bidRequest.findUnique({
      where: { id: data.bidRequestId },
      include: { invitations: true },
    });
    if (!bid) throw new NotFoundException('Bid request not found');
    if (bid.status !== BidRequestStatus.abierta) throw new BadRequestException('Bid is closed');
    if (bid.deadline && new Date() > bid.deadline) throw new BadRequestException('Deadline passed');

    const isInvited = bid.invitations.some((i) => i.distributorId === data.distributorId);
    if (!isInvited && !bid.isPublic) throw new BadRequestException('Not invited to this bid');

    return this.prisma.bidResponse.upsert({
      where: {
        bidRequestId_distributorId: {
          bidRequestId: data.bidRequestId,
          distributorId: data.distributorId,
        },
      },
      create: {
        bidRequestId: data.bidRequestId,
        distributorId: data.distributorId,
        status: BidResponseStatus.rechazada,
        cotizacion: [] as any,
        totalCotizado: 0,
        notas: data.notas ?? null,
        incluyeIva: false,
        tiempoEntrega: null,
        submittedAt: new Date(),
      },
      update: {
        status: BidResponseStatus.rechazada,
        cotizacion: [] as any,
        totalCotizado: 0,
        notas: data.notas ?? null,
        submittedAt: new Date(),
      },
    });
  }

  // ===========================================================================
  // DISTRIBUTOR LISTINGS — Ecommerce
  // ===========================================================================

  // -- Fuzzy brand matching --------------------------------------------------
  // The full brand list is small (~50 entries) so caching it for an hour is
  // cheap and lets us run a Levenshtein distance against every marca per
  // query without hitting the DB more than once an hour.
  private brandListCache: { brands: string[]; expiresAt: number } | null = null;
  private modelListCache: { models: string[]; expiresAt: number } | null = null;

  private async getDistinctBrands(): Promise<string[]> {
    if (this.brandListCache && this.brandListCache.expiresAt > Date.now()) {
      return this.brandListCache.brands;
    }
    const rows = await this.prisma.distributorListing.findMany({
      where: { isActive: true, marca: { not: '' } },
      distinct: ['marca'],
      select: { marca: true },
    });
    const brands = rows.map((r) => r.marca).filter(Boolean);
    this.brandListCache = { brands, expiresAt: Date.now() + 60 * 60 * 1000 };
    return brands;
  }

  // -- Brand info pages ------------------------------------------------------
  // Cache for 15 minutes — brand info rarely changes and the frontend hits
  // these on every product page load.
  private readonly BRAND_TTL = 15 * 60 * 1000;

  async listBrands() {
    const cached = this.cache.get<any>('brands:list');
    if (cached) return cached;
    const brands = await this.prisma.brandInfo.findMany({
      orderBy: { name: 'asc' },
    });
    const counts = await this.prisma.distributorListing.groupBy({
      by: ['marca'],
      where: { isActive: true },
      _count: { _all: true },
    });
    const countByMarca = new Map(counts.map((c) => [c.marca.toLowerCase(), c._count._all]));
    const result = brands.map((b) => ({
      ...b,
      listingCount: countByMarca.get(b.name.toLowerCase()) ?? 0,
    }));
    this.cache.set('brands:list', result, this.BRAND_TTL);
    return result;
  }

  async getBrandBySlug(slug: string) {
    const cacheKey = `brands:slug:${slug}`;
    const cached = this.cache.get<any>(cacheKey);
    if (cached) return cached;

    const brand = await this.prisma.brandInfo.findUnique({ where: { slug } });
    if (!brand) throw new NotFoundException('Brand not found');

    const listings = await this.prisma.distributorListing.findMany({
      where: { isActive: true, marca: { equals: brand.name, mode: 'insensitive' } },
      orderBy: [{ imageQualityScore: 'desc' }, { createdAt: 'desc' }],
      take: 24,
      include: {
        distributor: { select: { id: true, slug: true, name: true, profileImage: true } },
        catalog: { select: { id: true, terreno: true, kmEstimadosReales: true, cpkEstimado: true, crowdAvgCpk: true } },
        _count: { select: { reviews: true, orders: true } },
        reviews: { select: { rating: true }, take: 10 },
      },
    });
    const total = await this.prisma.distributorListing.count({
      where: { isActive: true, marca: { equals: brand.name, mode: 'insensitive' } },
    });
    const result = { ...brand, listings, total };
    this.cache.set(cacheKey, result, this.BRAND_TTL);
    return result;
  }

  invalidateBrandCaches() {
    this.cache.invalidate('brands:');
  }

  // -- Admin brand editor ----------------------------------------------------

  private readonly adminBrandFields = [
    'name', 'slug', 'logoUrl', 'country', 'headquarters', 'foundedYear',
    'website', 'description', 'parentCompany', 'tier', 'sourceUrl',
    'primaryColor', 'accentColor', 'heroImageUrl', 'tagline', 'published',
  ];

  private pickBrand(data: Record<string, any>) {
    const out: Record<string, any> = {};
    for (const k of this.adminBrandFields) {
      if (k in data) {
        const v = data[k];
        out[k] = v === '' ? null : v;
      }
    }
    if (out.foundedYear != null && typeof out.foundedYear === 'string') {
      const n = parseInt(out.foundedYear, 10);
      out.foundedYear = Number.isFinite(n) ? n : null;
    }
    return out;
  }

  async adminListBrands() {
    return this.prisma.brandInfo.findMany({ orderBy: { name: 'asc' } });
  }

  async adminGetBrand(id: string) {
    const brand = await this.prisma.brandInfo.findUnique({ where: { id } });
    if (!brand) throw new NotFoundException('Brand not found');
    return brand;
  }

  async adminCreateBrand(data: Record<string, any>) {
    const payload = this.pickBrand(data);
    if (!payload.name || !payload.slug) {
      throw new BadRequestException('name and slug are required');
    }
    const created = await this.prisma.brandInfo.create({
      data: { ...payload, source: payload.source ?? 'manual' },
    });
    this.invalidateBrandCaches();
    return created;
  }

  async adminUpdateBrand(id: string, data: Record<string, any>) {
    const payload = this.pickBrand(data);
    const updated = await this.prisma.brandInfo.update({ where: { id }, data: payload });
    this.invalidateBrandCaches();
    return updated;
  }

  async adminDeleteBrand(id: string) {
    await this.prisma.brandInfo.delete({ where: { id } });
    this.invalidateBrandCaches();
    return { ok: true };
  }

  private async fuzzyMatchBrands(query: string): Promise<string[]> {
    const q = query.trim().toLowerCase();
    if (q.length < 3) return [];
    const brands = await this.getDistinctBrands();
    const scored = brands
      .map((b) => ({ brand: b, distance: levenshtein(q, b.toLowerCase()) }))
      .filter(({ brand, distance }) => {
        // Tolerance scales with brand length: short names allow 1 typo,
        // longer names up to 30% of the length (rounded down).
        const tolerance = Math.max(1, Math.min(3, Math.floor(brand.length * 0.3)));
        return distance > 0 && distance <= tolerance;
      })
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 5);
    return scored.map((s) => s.brand);
  }

  private async getDistinctModels(): Promise<string[]> {
    if (this.modelListCache && this.modelListCache.expiresAt > Date.now()) {
      return this.modelListCache.models;
    }
    const rows = await this.prisma.distributorListing.findMany({
      where: { isActive: true, modelo: { not: '' } },
      distinct: ['modelo'],
      select: { modelo: true },
    });
    const models = rows.map((r) => r.modelo).filter(Boolean);
    this.modelListCache = { models, expiresAt: Date.now() + 60 * 60 * 1000 };
    return models;
  }

  /**
   * Fuzzy-match a search query against every distinct model currently on
   * sale. Used to surface "HDR2" when the user types "hdr3", "x-trail" when
   * they type "xtrail", etc. Tolerance scales with model-name length; short
   * codes (FS400) allow 1 edit, longer names up to ~25% of the length.
   */
  private async fuzzyMatchModels(query: string): Promise<string[]> {
    const q = query.trim().toLowerCase();
    if (q.length < 3) return [];
    const models = await this.getDistinctModels();
    const scored = models
      .map((m) => ({ model: m, distance: levenshtein(q, m.toLowerCase()) }))
      .filter(({ model, distance }) => {
        // Model names like "HDR2" are 4 chars — tolerate 1 edit.
        // Longer ones like "Pilot Sport 4" tolerate up to 3.
        const tolerance = Math.max(1, Math.min(3, Math.floor(model.length * 0.25)));
        return distance > 0 && distance <= tolerance;
      })
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 8);
    return scored.map((s) => s.model);
  }


  async searchListings(filters: {
    dimension?: string;
    marca?: string;
    eje?: string;
    tipo?: string;
    distributorId?: string;
    ciudad?: string;
    minPrice?: number;
    maxPrice?: number;
    search?: string;
    rimSizes?: string;
    sortBy?: string;
    page?: number;
    limit?: number;
  }) {
    const cacheKey = `listings:${JSON.stringify(filters)}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const where: any = { isActive: true };

    if (filters.dimension) where.dimension = filters.dimension;
    if (filters.marca) where.marca = { contains: filters.marca, mode: 'insensitive' };
    if (filters.eje) where.eje = filters.eje;
    if (filters.tipo) where.tipo = filters.tipo;
    if (filters.distributorId) where.distributorId = filters.distributorId;

    // City coverage filter — only show listings from distributors that cover this city
    if (filters.ciudad) {
      where.distributor = {
        cobertura: { array_contains: [filters.ciudad] },
      };
    }
    if (filters.minPrice || filters.maxPrice) {
      where.precioCop = {};
      if (filters.minPrice) where.precioCop.gte = filters.minPrice;
      if (filters.maxPrice) where.precioCop.lte = filters.maxPrice;
    }
    if (filters.search) {
      const raw = filters.search.trim();
      // Tokenize. A multi-token query like "CT8 225" or "Continental
      // HDR 295" only makes sense as AND-of-tokens — no single field
      // would ever match the whole string, so the previous OR-on-raw
      // returned nothing. We split, build a per-token OR across every
      // searchable field, then AND the tokens together.
      const tokens = raw.split(/\s+/).filter(Boolean);

      // Per-token OR clause: marca / modelo / dimension (with the same
      // dimension variants we used to compute on the whole string) /
      // distributor name. Alphabetic tokens of length ≥3 also get
      // fuzzy-expanded against the live brand + model lists so typos
      // ("michellin" → "Michelin") still hit.
      const buildTokenOr = async (t: string) => {
        const compact    = t.replace(/\s+/g, '').toUpperCase();
        const withSpaceR = compact.replace(/R/, ' R');
        const noSpaceR   = compact.replace(/\s+R/i, 'R');
        const dimVariants = Array.from(new Set([t, compact, withSpaceR, noSpaceR]));

        const orClauses: any[] = [
          { marca:  { contains: t, mode: 'insensitive' as const } },
          { modelo: { contains: t, mode: 'insensitive' as const } },
          ...dimVariants.map((v) => ({
            dimension: { contains: v, mode: 'insensitive' as const },
          })),
          { distributor: { name: { contains: t, mode: 'insensitive' as const } } },
        ];

        // Skip Levenshtein for purely numeric tokens — "225" is meant
        // to be a literal dimension fragment, not a fuzzy brand match.
        if (/[a-z]/i.test(t) && t.length >= 3) {
          const [fb, fm] = await Promise.all([
            this.fuzzyMatchBrands(t),
            this.fuzzyMatchModels(t),
          ]);
          for (const b of fb) orClauses.push({ marca:  { equals: b, mode: 'insensitive' as const } });
          for (const m of fm) orClauses.push({ modelo: { equals: m, mode: 'insensitive' as const } });
        }

        return { OR: orClauses };
      };

      const tokenAnd = await Promise.all(tokens.map(buildTokenOr));

      if (tokenAnd.length === 1) {
        // Single token → keep using `where.OR` so the rim-sizes branch
        // below can still merge cleanly the way it always has.
        where.OR = tokenAnd[0].OR;
      } else if (tokenAnd.length > 1) {
        where.AND = tokenAnd;
      }
    }
    // Category filter — comma-separated list of rim sizes (e.g. "17.5,19.5,22.5").
    // Matches dimensions that contain "R<rim>" (case-insensitive). The
    // dimension column stores values like "295/80 R22.5" so a contains
    // search on "R22.5" yields all 22.5" tires.
    if (filters.rimSizes) {
      const rims = filters.rimSizes
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean);
      if (rims.length > 0) {
        const rimOr = rims.map((r) => ({
          dimension: { contains: `R${r}`, mode: 'insensitive' as const },
        }));
        // Three combine cases now that the search branch may produce
        // either `where.OR` (single token) or `where.AND` (multi-token):
        if (where.AND) {
          (where.AND as any[]).push({ OR: rimOr });
        } else if (where.OR) {
          where.AND = [{ OR: where.OR }, { OR: rimOr }];
          delete where.OR;
        } else {
          where.OR = rimOr;
        }
      }
    }

    // Inventory-aware ranking — prepended to every sort branch. The
    // `inventoryRank` column is a Postgres-generated `LEAST(cantidad, 50)`,
    // so listings with ≥50 units all tie for the top tier and the
    // user's chosen criterion (price / recency / relevance) acts as
    // the tiebreaker among them. Listings with <50 units sub-rank by
    // their actual count so a tire with 30 in stock still beats one
    // with 5 — this is what the user means by "if there's a ton of
    // tires for one then that one must be displayed first".
    let orderBy: any;
    switch (filters.sortBy) {
      case 'price_asc':  orderBy = [{ inventoryRank: 'desc' }, { precioCop: 'asc'  }]; break;
      case 'price_desc': orderBy = [{ inventoryRank: 'desc' }, { precioCop: 'desc' }]; break;
      case 'newest':     orderBy = [{ inventoryRank: 'desc' }, { createdAt: 'desc' }]; break;
      // Default: stock first, then image quality, then newest.
      default: orderBy = [{ inventoryRank: 'desc' }, { imageQualityScore: 'desc' }, { createdAt: 'desc' }];
    }

    const page = filters.page ?? 1;
    const limit = Math.min(filters.limit ?? 20, 50);

    const [listings, total] = await Promise.all([
      this.prisma.distributorListing.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
        include: {
          distributor: { select: { id: true, slug: true, name: true, profileImage: true } },
          catalog: {
            select: {
              id: true, skuRef: true, terreno: true, reencauchable: true,
              kmEstimadosReales: true, cpkEstimado: true, crowdAvgCpk: true,
              crowdAvgPrice: true, psiRecomendado: true, rtdMm: true,
            },
          },
          _count: { select: { reviews: true, orders: true } },
          reviews: { select: { rating: true }, take: 10 },
        },
      }),
      this.prisma.distributorListing.count({ where }),
    ]);

    const result = { listings, total, page, limit, pages: Math.ceil(total / limit) };
    this.cache.set(cacheKey, result, this.LISTINGS_TTL);
    return result;
  }

  async getDistributorListings(distributorId: string) {
    return this.prisma.distributorListing.findMany({
      where: { distributorId },
      orderBy: { updatedAt: 'desc' },
      include: {
        catalog: { select: { id: true, skuRef: true, marca: true, modelo: true, dimension: true } },
        _count: { select: { orders: true, reviews: true } },
      },
    });
  }

  async createListing(data: {
    distributorId: string;
    catalogId?: string;
    marca: string;
    modelo: string;
    dimension: string;
    eje?: string;
    tipo?: string;
    precioCop: number;
    precioPromo?: number;
    promoHasta?: string;
    incluyeIva?: boolean;
    cantidadDisponible?: number;
    tiempoEntrega?: string;
    descripcion?: string;
    imageUrls?: string[];
    coverIndex?: number;
  }) {
    // Normalize dimension to the canonical form before catalog lookup and
    // persistence. The catalog's own dimensions are already canonical after
    // the one-shot normalization migration.
    data.dimension = normalizeDimension(data.dimension);

    // Auto-link to catalog by marca+modelo+dimension. If nothing matches,
    // auto-create a master catalog SKU so the new marketplace listing
    // shows up in the distributor's /dashboard/catalogoSku list right
    // away (one of the user-facing requirements: "tires created in
    // marketplace get immediately added to the catalog of the company").
    if (!data.catalogId && data.marca && data.modelo && data.dimension) {
      const catalog = await this.prisma.tireMasterCatalog.findFirst({
        where: { marca: { equals: data.marca, mode: 'insensitive' }, modelo: { equals: data.modelo, mode: 'insensitive' }, dimension: data.dimension },
      });
      if (catalog) {
        data.catalogId = catalog.id;
      } else {
        const skuRef = this.makeAutoSkuRef(data.marca, data.modelo, data.dimension);
        try {
          const created = await this.prisma.tireMasterCatalog.create({
            data: {
              marca:     data.marca,
              modelo:    data.modelo,
              dimension: data.dimension,
              skuRef,
              fuente:    'distribuidor',
            },
          });
          data.catalogId = created.id;
        } catch (e) {
          // Race: another distributor created the same combo between our
          // findFirst and create. Re-look up by skuRef and reuse — both
          // distributors end up subscribed to the same master SKU.
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
            const fallback = await this.prisma.tireMasterCatalog.findUnique({ where: { skuRef } });
            if (fallback) data.catalogId = fallback.id;
          } else {
            throw e;
          }
        }
      }
    }
    // If catalogId provided, enrich from catalog. If the supplied id doesn't
    // exist (stale frontend cache, manual paste, etc.) drop it so Prisma
    // doesn't blow up with a P2003 foreign-key violation.
    if (data.catalogId) {
      const catalog = await this.prisma.tireMasterCatalog.findUnique({ where: { id: data.catalogId } });
      if (catalog) {
        data.marca = data.marca || catalog.marca;
        data.modelo = data.modelo || catalog.modelo;
        data.dimension = data.dimension || catalog.dimension;
      } else {
        data.catalogId = undefined;
      }
    }

    const imageQualityScore = await this.scoreImageQuality(data.imageUrls ?? null);

    const result = await this.prisma.distributorListing.create({
      data: {
        distributorId: data.distributorId,
        catalogId: data.catalogId ?? null,
        marca: data.marca,
        modelo: data.modelo,
        dimension: data.dimension,
        eje: data.eje as any ?? null,
        tipo: data.tipo ?? 'nueva',
        precioCop: data.precioCop,
        precioPromo: data.precioPromo ?? null,
        promoHasta: data.promoHasta ? new Date(data.promoHasta) : null,
        incluyeIva: data.incluyeIva ?? false,
        cantidadDisponible: data.cantidadDisponible ?? 0,
        tiempoEntrega: data.tiempoEntrega ?? null,
        descripcion: data.descripcion ?? null,
        imageUrls: (data.imageUrls ?? undefined) as any,
        coverIndex: data.coverIndex ?? 0,
        imageQualityScore,
      },
    });

    // Subscribe the distributor to the master catalog SKU so the product
    // appears in their /dashboard/catalogoSku immediately. Idempotent
    // upsert keeps re-creates of the same listing safe.
    if (data.catalogId) {
      await this.prisma.catalogSubscription.upsert({
        where:  { catalogId_companyId: { catalogId: data.catalogId, companyId: data.distributorId } },
        update: {},
        create: { catalogId: data.catalogId, companyId: data.distributorId },
      }).catch(() => { /* non-fatal: listing exists, sub will heal on next create */ });
    }

    this.invalidateListingCaches();
    return result;
  }

  /**
   * Build a deterministic master-catalog skuRef for marketplace
   * auto-creates. Deterministic by marca+modelo+dimension (not by
   * distributor) so two distributors selling the same physical SKU
   * collapse to one master row, and both end up subscribed to it.
   */
  private makeAutoSkuRef(marca: string, modelo: string, dimension: string) {
    const slug = (s: string) =>
      s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 24);
    return `MKT-${slug(marca)}-${slug(modelo)}-${slug(dimension)}`.slice(0, 80);
  }

  /**
   * Preview which listings will be affected by a bulk-by-banda
   * update. Returns the lightweight list (id, marca, modelo,
   * dimension) so the UI can show a "you're about to update X
   * listings" confirmation before committing.
   */
  async previewListingsByBanda(
    distributorId: string,
    marca: string,
    modeloContains: string,
  ) {
    if (!distributorId) throw new BadRequestException('distributorId is required');
    if (!marca?.trim()) throw new BadRequestException('marca is required');
    if (!modeloContains?.trim()) throw new BadRequestException('modeloContains is required');
    return this.prisma.distributorListing.findMany({
      where: {
        distributorId,
        marca:  { equals:   marca.trim(),          mode: 'insensitive' },
        modelo: { contains: modeloContains.trim(), mode: 'insensitive' },
      },
      select: { id: true, marca: true, modelo: true, dimension: true, isActive: true },
      orderBy: [{ dimension: 'asc' }],
    });
  }

  /**
   * Apply images + description in bulk to every listing under a
   * distributor matching marca + modelo-substring. Useful when a
   * distributor has the same banda (e.g. "ATX") in 10 different
   * dimensions and wants to push the same hero photos + copy to all
   * of them at once.
   *
   * Empty/undefined values are no-ops on the field — passing only
   * `imageUrls` updates just images and leaves the description
   * untouched, and vice versa.
   */
  async bulkUpdateByBanda(input: {
    distributorId: string;
    marca: string;
    modeloContains: string;
    imageUrls?: string[];
    descripcion?: string;
  }) {
    if (!input.distributorId) throw new BadRequestException('distributorId is required');
    if (!input.marca?.trim()) throw new BadRequestException('marca is required');
    if (!input.modeloContains?.trim()) throw new BadRequestException('modeloContains is required');
    if ((input.imageUrls === undefined || input.imageUrls.length === 0) &&
        (input.descripcion === undefined || input.descripcion === null)) {
      throw new BadRequestException('Pasa imageUrls o descripcion para aplicar');
    }

    const matching = await this.prisma.distributorListing.findMany({
      where: {
        distributorId: input.distributorId,
        marca:  { equals:   input.marca.trim(),          mode: 'insensitive' },
        modelo: { contains: input.modeloContains.trim(), mode: 'insensitive' },
      },
      select: { id: true },
    });
    if (matching.length === 0) {
      return { updated: 0, ids: [] };
    }

    // Trim image array to the 5-image cap that single-create + edit
    // already enforce, so this endpoint can't sneak in oversized arrays.
    const imageUrls = Array.isArray(input.imageUrls)
      ? input.imageUrls.slice(0, 5)
      : undefined;

    const data: any = {};
    if (imageUrls) {
      data.imageUrls  = imageUrls;
      data.coverIndex = 0;
    }
    if (typeof input.descripcion === 'string') {
      data.descripcion = input.descripcion.trim() || null;
    }

    const ids = matching.map((m) => m.id);
    await this.prisma.distributorListing.updateMany({
      where: { id: { in: ids } },
      data,
    });
    this.invalidateListingCaches();
    // Per-listing product:<id> cache lives in the marketplace cache;
    // wipe entries en bloc.
    for (const id of ids) this.cache.invalidate(`product:${id}`);
    return { updated: ids.length, ids };
  }

  /**
   * Spreadsheet bulk-upload. Each row goes through the regular
   * createListing pipeline so catalog auto-create + dist subscription
   * happen consistently. Errors don't fail the batch — we collect
   * them and return a structured summary the UI can surface.
   */
  async bulkCreateListings(distributorId: string, items: Array<{
    marca: string;
    modelo: string;
    dimension: string;
    eje?: string;
    tipo?: string;
    precioCop: number;
    cantidadDisponible?: number;
    descripcion?: string;
    tiempoEntrega?: string;
  }>) {
    if (!distributorId) throw new BadRequestException('distributorId is required');
    if (!Array.isArray(items) || items.length === 0) {
      throw new BadRequestException('items array is required');
    }
    if (items.length > 500) {
      throw new BadRequestException('Máximo 500 productos por carga');
    }

    const created: string[] = [];
    const errors: Array<{ row: number; reason: string; identifier?: string }> = [];

    for (let i = 0; i < items.length; i++) {
      const row = items[i];
      const idLabel = `${row.marca ?? '?'} ${row.modelo ?? '?'} ${row.dimension ?? '?'}`.trim();
      try {
        if (!row.marca?.trim() || !row.modelo?.trim() || !row.dimension?.trim()) {
          errors.push({ row: i + 1, reason: 'marca, modelo y dimensión son obligatorios', identifier: idLabel });
          continue;
        }
        if (typeof row.precioCop !== 'number' || row.precioCop <= 0) {
          errors.push({ row: i + 1, reason: 'Precio inválido', identifier: idLabel });
          continue;
        }
        const listing = await this.createListing({
          distributorId,
          marca:              row.marca.trim(),
          modelo:             row.modelo.trim(),
          dimension:          row.dimension.trim(),
          eje:                row.eje?.trim() || undefined,
          tipo:               row.tipo?.trim() || 'nueva',
          precioCop:          Math.round(row.precioCop),
          cantidadDisponible: typeof row.cantidadDisponible === 'number' ? row.cantidadDisponible : 0,
          tiempoEntrega:      row.tiempoEntrega?.trim() || undefined,
          descripcion:        row.descripcion?.trim() || undefined,
        });
        created.push(listing.id);
      } catch (e: any) {
        this.logger.warn(`bulk row ${i + 1} (${idLabel}) failed: ${e?.message ?? e}`);
        errors.push({
          row: i + 1,
          reason: (e?.message?.toString() ?? 'Error desconocido').slice(0, 200),
          identifier: idLabel,
        });
      }
    }

    return { created: created.length, errors, createdIds: created };
  }

  private invalidateListingCaches() {
    this.cache.invalidate('listings:');
    this.cache.invalidate('filters');
    this.cache.invalidate('recs:');
    this.cache.invalidate('product:');
  }

  async updateListing(id: string, distributorId: string, data: Partial<{
    precioCop: number;
    precioPromo: number | null;
    promoHasta: string | null;
    cantidadDisponible: number;
    tiempoEntrega: string;
    descripcion: string;
    marca: string;
    modelo: string;
    imageUrls: string[];
    coverIndex: number;
    isActive: boolean;
  }>) {
    const listing = await this.prisma.distributorListing.findUnique({ where: { id } });
    if (!listing) throw new NotFoundException('Listing not found');
    if (listing.distributorId !== distributorId) throw new BadRequestException('Not your listing');

    const updateData: any = { ...data };
    if (data.promoHasta !== undefined) {
      updateData.promoHasta = data.promoHasta ? new Date(data.promoHasta) : null;
    }

    const result = await this.prisma.distributorListing.update({ where: { id }, data: updateData });
    this.invalidateListingCaches();
    this.cache.invalidate(`product:${id}`);
    return result;
  }

  async deleteListing(id: string, distributorId: string) {
    const listing = await this.prisma.distributorListing.findUnique({ where: { id } });
    if (!listing) throw new NotFoundException('Listing not found');
    if (listing.distributorId !== distributorId) throw new BadRequestException('Not your listing');

    const result = await this.prisma.distributorListing.update({
      where: { id },
      data: { isActive: false },
    });
    this.invalidateListingCaches();
    return result;
  }

  // ===========================================================================
  // MARKETPLACE FILTERS — for dropdown population
  // ===========================================================================

  async getMarketplaceFilters() {
    const cached = this.cache.get('filters');
    if (cached) return cached;

    const [dimensions, marcas, distributorIds] = await Promise.all([
      this.prisma.distributorListing.findMany({
        where: { isActive: true },
        select: { dimension: true },
        distinct: ['dimension'],
        orderBy: { dimension: 'asc' },
      }),
      this.prisma.distributorListing.findMany({
        where: { isActive: true },
        select: { marca: true },
        distinct: ['marca'],
        orderBy: { marca: 'asc' },
      }),
      this.prisma.distributorListing.findMany({
        where: { isActive: true },
        select: { distributorId: true },
        distinct: ['distributorId'],
      }),
    ]);

    const distributors = distributorIds.length > 0
      ? await this.prisma.company.findMany({
          where: { id: { in: distributorIds.map((d) => d.distributorId) } },
          select: { id: true, slug: true, name: true, profileImage: true, ciudad: true },
          orderBy: { name: 'asc' },
        })
      : [];

    const result = { dimensions: dimensions.map((d) => d.dimension), marcas: marcas.map((m) => m.marca), distributors };
    this.cache.set('filters', result, this.FILTERS_TTL);
    return result;
  }

  // ===========================================================================
  // DISTRIBUTOR PUBLIC PROFILE
  // ===========================================================================

  // UUID v4 shape — used to choose between id-lookup and slug-lookup. We
  // accept both at this endpoint so the public marketplace can use clean
  // slug URLs (/marketplace/distributor/merquellantas) while internal
  // dashboards keep linking by UUID without breaking.
  private readonly UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  async getDistributorProfile(distributorIdOrSlug: string) {
    const cacheKey = `distprofile:${distributorIdOrSlug}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const where = this.UUID_RE.test(distributorIdOrSlug)
      ? { id: distributorIdOrSlug }
      : { slug: distributorIdOrSlug };

    const company = await this.prisma.company.findUnique({
      where,
      select: {
        id: true, slug: true, name: true, profileImage: true, plan: true,
        emailAtencion: true, telefono: true, descripcion: true,
        bannerImage: true, direccion: true, ciudad: true, sitioWeb: true,
        cobertura: true, tipoEntrega: true, colorMarca: true,
        promoBannerImage: true, promoBannerTitle: true,
        promoBannerSubtitle: true, promoBannerHref: true,
        pinnedListingId: true,
        _count: { select: { listings: { where: { isActive: true } } } },
      },
    });
    if (!company) throw new NotFoundException('Distributor not found');

    // Resolve the pinned listing (if any) so the storefront can render
    // a featured-product card alongside the banner without a second
    // round trip. Null-safe — if the pin points at a deleted/inactive
    // listing or another distributor's listing, we just return null.
    let pinnedListing: {
      id: string; marca: string; modelo: string; dimension: string;
      precioCop: number; precioPromo: number | null; promoHasta: Date | null;
      imageUrls: any; coverIndex: number;
    } | null = null;
    if (company.pinnedListingId) {
      pinnedListing = await this.prisma.distributorListing.findFirst({
        where: { id: company.pinnedListingId, distributorId: company.id, isActive: true },
        select: {
          id: true, marca: true, modelo: true, dimension: true,
          precioCop: true, precioPromo: true, promoHasta: true,
          imageUrls: true, coverIndex: true,
        },
      });
    }
    const out = { ...company, pinnedListing };
    this.cache.set(cacheKey, out, this.PROFILE_TTL);
    return out;
  }

  async updateDistributorProfile(distributorId: string, data: Partial<{
    telefono: string; descripcion: string; bannerImage: string;
    direccion: string; ciudad: string; sitioWeb: string; emailAtencion: string;
    cobertura: any[]; tipoEntrega: string; colorMarca: string;
    profileImage: string;
    // Pinned promo banner — edited from /dashboard/marketplace/perfil
    // and rendered on /marketplace/distributor/<slug>. Nullable so the
    // dist can clear any single field independently.
    promoBannerImage: string | null;
    promoBannerTitle: string | null;
    promoBannerSubtitle: string | null;
    promoBannerHref: string | null;
    // Loose ref to one of the dist's own listings — the storefront
    // resolves it server-side, so passing an ID for a listing that
    // doesn't exist (or belongs to someone else) just hides the
    // pinned card without erroring on save.
    pinnedListingId: string | null;
  }>) {
    const result = await this.prisma.company.update({ where: { id: distributorId }, data });
    // The profile cache is keyed by whatever the caller passed in
    // (UUID OR slug). Invalidating only by UUID leaves the slug-keyed
    // entry alive for the full TTL — which is exactly the path the
    // public storefront uses, so saved changes wouldn't show up there
    // for up to 5 minutes. Drop both keys.
    this.cache.invalidate(`distprofile:${distributorId}`);
    if (result.slug) this.cache.invalidate(`distprofile:${result.slug}`);
    this.cache.invalidate('distmap');
    return result;
  }

  // ===========================================================================
  // REVIEWS
  // ===========================================================================

  async createReview(data: { listingId: string; userId: string; rating: number; comment?: string }) {
    if (data.rating < 1 || data.rating > 5) throw new BadRequestException('Rating must be 1-5');

    const result = await this.prisma.distributorReview.upsert({
      where: { listingId_userId: { listingId: data.listingId, userId: data.userId } },
      create: { listingId: data.listingId, userId: data.userId, rating: data.rating, comment: data.comment ?? null },
      update: { rating: data.rating, comment: data.comment ?? null },
    });
    this.cache.invalidate(`product:${data.listingId}`);
    return result;
  }

  async getListingReviews(listingId: string) {
    const reviews = await this.prisma.distributorReview.findMany({
      where: { listingId },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { name: true } } },
    });

    const avg = reviews.length > 0
      ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length
      : 0;

    return { reviews, average: Math.round(avg * 10) / 10, count: reviews.length };
  }

  // ===========================================================================
  // SINGLE LISTING (product detail)
  // ===========================================================================

  async getListingById(id: string) {
    const cacheKey = `product:${id}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const listing = await this.prisma.distributorListing.findUnique({
      where: { id },
      include: {
        distributor: { select: { id: true, slug: true, name: true, profileImage: true, ciudad: true, telefono: true, emailAtencion: true, tipoEntrega: true, cobertura: true } },
        catalog: {
          select: {
            id: true, skuRef: true, terreno: true, reencauchable: true,
            kmEstimadosReales: true, kmEstimadosFabrica: true,
            cpkEstimado: true, crowdAvgCpk: true, psiRecomendado: true, rtdMm: true,
            indiceCarga: true, indiceVelocidad: true, vidasReencauche: true,
            anchoMm: true, perfil: true, rin: true,
            posicion: true, ejeTirePro: true, pesoKg: true,
            pctPavimento: true, pctDestapado: true,
            segmento: true, tipo: true, construccion: true,
            notasColombia: true, fuente: true,
            crowdAvgPrice: true, crowdAvgKm: true,
            crowdConfidence: true, crowdCompanyCount: true,
          },
        },
        reviews: { include: { user: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 20 },
        _count: { select: { reviews: true } },
      },
    });
    if (!listing) throw new NotFoundException('Listing not found');

    // Add sales count
    const salesCount = await this.prisma.marketplaceOrder.aggregate({
      where: { listingId: id },
      _sum: { quantity: true },
    });

    const result = { ...listing, totalSold: salesCount._sum.quantity ?? 0 };
    this.cache.set(cacheKey, result, this.PRODUCT_TTL);
    return result;
  }

  // ===========================================================================
  // MARKETPLACE ORDERS
  // ===========================================================================

  async createOrder(data: {
    listingId: string;
    quantity: number;
    userId?: string;
    buyerName: string;
    buyerEmail: string;
    buyerPhone?: string;
    buyerAddress?: string;
    buyerCity?: string;
    buyerCompany?: string;
    notas?: string;
  }) {
    const listing = await this.prisma.distributorListing.findUnique({
      where: { id: data.listingId },
      include: { distributor: { select: { id: true, slug: true, name: true, emailAtencion: true } } },
    });
    if (!listing) throw new NotFoundException('Listing not found');

    const totalCop = listing.precioCop * data.quantity;

    const now = new Date().toISOString();
    const order = await this.prisma.marketplaceOrder.create({
      data: {
        listingId: data.listingId,
        distributorId: listing.distributorId,
        quantity: data.quantity,
        totalCop,
        userId: data.userId ?? null,
        buyerName: data.buyerName,
        buyerEmail: data.buyerEmail,
        buyerPhone: data.buyerPhone ?? null,
        buyerAddress: data.buyerAddress ?? null,
        buyerCity: data.buyerCity ?? null,
        buyerCompany: data.buyerCompany ?? null,
        notas: data.notas ?? null,
        // Seed the audit log with the initial pendiente event so the
        // tracking timeline always has at least one entry to render.
        statusHistory: [{ status: 'pendiente', at: now }] as any,
      },
      include: { listing: true },
    });

    // Resolve cover image once for all downstream emails so they share
    // the same hero shot the buyer just clicked on.
    const listingImgs = Array.isArray((listing as any).imageUrls) ? (listing as any).imageUrls as string[] : [];
    const listingCover = listingImgs.length > 0
      ? (listingImgs[(listing as any).coverIndex ?? 0] ?? listingImgs[0])
      : null;

    // Send confirmation email to buyer
    try {
      await this.email.sendOrderConfirmation({
        buyerEmail:      data.buyerEmail,
        buyerName:       data.buyerName,
        orderId:         order.id,
        distributorName: listing.distributor.name,
        listing: {
          marca:     listing.marca,
          modelo:    listing.modelo,
          dimension: listing.dimension,
          imageUrl:  listingCover,
        },
        quantity:     data.quantity,
        totalCop:     totalCop,
        buyerAddress: data.buyerAddress,
        buyerCity:    data.buyerCity,
      });
    } catch (err) {
      this.logger.warn(`Failed to send order confirmation: ${err}`);
    }

    // Notify distributor
    try {
      const distEmail = listing.distributor.emailAtencion;
      if (distEmail) {
        await this.email.sendOrderToDistributor({
          distributorEmail: distEmail,
          orderId:          order.id,
          listing: {
            marca:     listing.marca,
            modelo:    listing.modelo,
            dimension: listing.dimension,
            imageUrl:  listingCover,
          },
          quantity:    data.quantity,
          totalCop:    totalCop,
          buyerName:   data.buyerName,
          buyerPhone:  data.buyerPhone,
          buyerCity:   data.buyerCity,
        });
      }
    } catch (err) {
      this.logger.warn(`Failed to send distributor notification: ${err}`);
    }

    this.cache.invalidate(`product:${data.listingId}`);
    this.cache.invalidate('recs:');
    return order;
  }

  /**
   * Email-gated order detail lookup. Used by the public tracking page
   * — anyone with the order id + the buyer's email gets the full
   * payload, anyone else gets a 403 (kept distinct from "order doesn't
   * exist" so we don't leak the existence of unrelated orders).
   */
  async trackOrder(orderId: string, providedEmail: string) {
    if (!orderId) throw new BadRequestException('orderId is required');
    if (!providedEmail || !providedEmail.trim()) {
      throw new BadRequestException('email is required');
    }
    const order = await this.prisma.marketplaceOrder.findUnique({
      where: { id: orderId },
      include: {
        listing: {
          select: {
            id: true, marca: true, modelo: true, dimension: true,
            imageUrls: true, coverIndex: true,
          },
        },
        distributor: {
          select: { id: true, name: true, slug: true, profileImage: true, telefono: true, ciudad: true },
        },
      },
    });
    if (!order) throw new NotFoundException('Order not found');

    const norm = (e: string) => e.trim().toLowerCase();
    if (norm(order.buyerEmail) !== norm(providedEmail)) {
      throw new ForbiddenException('Email does not match this order');
    }
    return order;
  }

  /**
   * Public tracking-page URL the buyer clicks from any order email.
   * Pinned at the prod marketplace host because emails get archived
   * and forwarded — env-derived URLs go stale fast in transactional
   * mail. Email is URL-encoded so + / spaces survive transit.
   */
  private buildTrackingUrl(orderId: string, buyerEmail: string): string {
    return `https://www.tirepro.com.co/marketplace/order/${orderId}?email=${encodeURIComponent(buyerEmail)}`;
  }

  async getDistributorOrders(distributorId: string) {
    return this.prisma.marketplaceOrder.findMany({
      where: { distributorId },
      orderBy: { createdAt: 'desc' },
      include: { listing: { select: { marca: true, modelo: true, dimension: true, imageUrls: true, coverIndex: true } } },
    });
  }

  // -- Return requests -------------------------------------------------------
  async requestOrderReturn(orderId: string, userId: string, reason: string) {
    const trimmed = (reason ?? '').trim();
    if (!trimmed) throw new BadRequestException('Reason is required');

    const order = await this.prisma.marketplaceOrder.findUnique({
      where: { id: orderId },
      select: { id: true, userId: true, buyerEmail: true, status: true, returnStatus: true, listing: { select: { marca: true, modelo: true } } },
    });
    if (!order) throw new NotFoundException('Order not found');
    // Only the buyer that placed the order may request the return.
    if (order.userId && order.userId !== userId) {
      throw new BadRequestException('Not your order');
    }
    if (order.returnStatus) {
      throw new BadRequestException('Return already requested for this order');
    }
    if (order.status !== 'enviado' && order.status !== 'entregado') {
      throw new BadRequestException('Solo se puede solicitar devolución una vez el pedido haya sido enviado o entregado');
    }

    return this.prisma.marketplaceOrder.update({
      where: { id: orderId },
      data: {
        returnStatus: 'pendiente',
        returnReason: trimmed,
        returnRequestedAt: new Date(),
      },
    });
  }

  async updateOrderReturnStatus(orderId: string, distributorId: string, returnStatus: 'aprobada' | 'rechazada') {
    if (returnStatus !== 'aprobada' && returnStatus !== 'rechazada') {
      throw new BadRequestException('Invalid return status');
    }
    const order = await this.prisma.marketplaceOrder.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.distributorId !== distributorId) throw new BadRequestException('Not your order');
    if (order.returnStatus !== 'pendiente') throw new BadRequestException('No pending return request');

    return this.prisma.marketplaceOrder.update({
      where: { id: orderId },
      data: { returnStatus, returnResolvedAt: new Date() },
    });
  }

  async updateOrderStatus(
    orderId: string,
    distributorId: string,
    status: string,
    cancelReason?: string,
    etaDateInput?: string | null,
  ) {
    const order = await this.prisma.marketplaceOrder.findUnique({
      where: { id: orderId },
      include: { listing: { select: { marca: true, modelo: true, dimension: true } } },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.distributorId !== distributorId) throw new BadRequestException('Not your order');

    // Parse ETA. Empty string / null clears the field; valid date sets
    // it; invalid input is rejected with a 400 so the dist sees the
    // problem instead of silently storing nothing.
    let etaUpdate: Date | null | undefined;
    if (etaDateInput === null || etaDateInput === '') {
      etaUpdate = null;
    } else if (typeof etaDateInput === 'string') {
      const parsed = new Date(etaDateInput);
      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestException('Invalid etaDate');
      }
      etaUpdate = parsed;
    } else {
      etaUpdate = undefined; // not touched
    }

    // Append to the audit log. Existing entries (or null for legacy
    // pre-statusHistory orders) flow through unchanged; we just push
    // the new event onto the end. ETA, when supplied, rides on the
    // event so the buyer's timeline can show "Confirmado · entrega
    // estimada 12 May" inline.
    const prevHistory: Array<{ status: string; at: string; note?: string; eta?: string | null }> =
      Array.isArray((order as any).statusHistory) ? (order as any).statusHistory : [];
    const nextHistory = [
      ...prevHistory,
      {
        status,
        at: new Date().toISOString(),
        ...(cancelReason ? { note: cancelReason } : {}),
        ...(etaUpdate instanceof Date ? { eta: etaUpdate.toISOString() } : {}),
      },
    ];

    const updated = await this.prisma.marketplaceOrder.update({
      where: { id: orderId },
      data: {
        status,
        statusHistory: nextHistory as any,
        ...(etaUpdate !== undefined ? { etaDate: etaUpdate } : {}),
        ...(cancelReason ? { notas: `[CANCELADO] ${cancelReason}${order.notas ? ` | Original: ${order.notas}` : ''}` } : {}),
      },
    });

    // Buyer-facing status change email — one branch per template so
    // the visual treatment matches the news (cancelled = danger,
    // confirmed = brand, delivered = success, etc.). All paths flow
    // through the shared shell in EmailService.
    if (order.buyerEmail) {
      const orderImgs = Array.isArray((order.listing as any).imageUrls) ? (order.listing as any).imageUrls as string[] : [];
      const orderCover = orderImgs.length > 0
        ? (orderImgs[(order.listing as any).coverIndex ?? 0] ?? orderImgs[0])
        : null;
      const dist = await this.prisma.company.findUnique({
        where: { id: distributorId },
        select: { name: true, telefono: true },
      });
      const distName  = dist?.name ?? 'El distribuidor';
      const distPhone = dist?.telefono ?? null;
      const listingPayload = {
        marca:     order.listing.marca,
        modelo:    order.listing.modelo,
        dimension: order.listing.dimension,
        imageUrl:  orderCover,
      };

      try {
        if (status === 'cancelado') {
          await this.email.sendOrderCancelled({
            buyerEmail:      order.buyerEmail,
            buyerName:       order.buyerName,
            orderId,
            distributorName: distName,
            listing:         listingPayload,
            quantity:        order.quantity,
            totalCop:        order.totalCop,
            cancelReason,
          });
        } else if (status === 'confirmado') {
          // Resolve the ETA the dist just set (if any) — `updated.etaDate`
          // is the freshest source; falls back to the order's previous
          // value if the dist re-confirmed without a date.
          const etaForEmail = (updated as any).etaDate ?? (order as any).etaDate ?? null;
          await this.email.sendOrderConfirmedByDistributor({
            buyerEmail:       order.buyerEmail,
            buyerName:        order.buyerName,
            orderId,
            distributorName:  distName,
            distributorPhone: distPhone,
            listing:          listingPayload,
            quantity:         order.quantity,
            totalCop:         order.totalCop,
            etaDate:          etaForEmail,
          });
        } else {
          // entregado, en preparación, listo para retirar — anything
          // outside the dedicated templates flows through the generic
          // status-change email.
          await this.email.sendOrderStatusChanged({
            buyerEmail:       order.buyerEmail,
            buyerName:        order.buyerName,
            orderId,
            newStatus:        status,
            distributorName:  distName,
            distributorPhone: distPhone,
            listing:          listingPayload,
            quantity:         order.quantity,
            totalCop:         order.totalCop,
          });
        }
      } catch (err: any) {
        this.logger.warn(`Failed to send status-change email (${status}): ${err?.message ?? err}`);
      }
    }

    return updated;
  }

  async getDistributorSalesStats(distributorId: string) {
    const notCanceled = { distributorId, status: { not: 'cancelado' } };
    const [orders, totalRevenue, totalSold, avgResponseTime, byListing, byMonth] = await Promise.all([
      this.prisma.marketplaceOrder.count({ where: notCanceled }),
      this.prisma.marketplaceOrder.aggregate({ where: notCanceled, _sum: { totalCop: true } }),
      this.prisma.marketplaceOrder.aggregate({ where: notCanceled, _sum: { quantity: true } }),
      // Average response time (created → first status change)
      this.prisma.$queryRaw`
        SELECT AVG(EXTRACT(EPOCH FROM ("updatedAt" - "createdAt")) / 3600)::float as avg_hours
        FROM marketplace_orders
        WHERE "distributorId" = ${distributorId} AND status != 'pendiente'
      `.then((r: any) => r[0]?.avg_hours ?? null).catch(() => null),
      this.prisma.marketplaceOrder.groupBy({
        by: ['listingId'],
        where: notCanceled,
        _sum: { quantity: true, totalCop: true },
        _count: true,
        orderBy: { _sum: { totalCop: 'desc' } },
        take: 10,
      }),
      this.prisma.$queryRaw`
        SELECT DATE_TRUNC('month', "createdAt") as month,
               COUNT(*)::int as orders,
               SUM("totalCop")::float as revenue,
               SUM("quantity")::int as units
        FROM marketplace_orders
        WHERE "distributorId" = ${distributorId} AND status != 'cancelado'
        GROUP BY month ORDER BY month DESC LIMIT 12
      ` as Promise<any[]>,
    ]);

    // Enrich top listings with names
    const listingIds = byListing.map((l) => l.listingId);
    const listings = listingIds.length > 0
      ? await this.prisma.distributorListing.findMany({
          where: { id: { in: listingIds } },
          select: { id: true, marca: true, modelo: true, dimension: true },
        })
      : [];
    const listingMap = new Map(listings.map((l) => [l.id, l]));

    return {
      totalOrders: orders,
      totalRevenue: totalRevenue._sum.totalCop ?? 0,
      totalUnitsSold: totalSold._sum.quantity ?? 0,
      avgResponseTimeHours: avgResponseTime != null ? Math.round(avgResponseTime * 10) / 10 : null,
      topListings: byListing.map((l) => ({
        listing: listingMap.get(l.listingId) ?? { marca: '?', modelo: '?', dimension: '?' },
        orders: l._count,
        unitsSold: l._sum.quantity ?? 0,
        revenue: l._sum.totalCop ?? 0,
      })),
      monthlyStats: byMonth,
    };
  }

  async getUserRecentOrders(userId: string, limit = 20) {
    return this.prisma.marketplaceOrder.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { listing: { select: { id: true, marca: true, modelo: true, dimension: true, imageUrls: true, coverIndex: true, precioCop: true } } },
    });
  }

  // ===========================================================================
  // RECOMMENDATIONS
  // ===========================================================================

  async getRecommendations(userId?: string, limit = 8) {
    const cacheKey = `recs:${userId ?? 'guest'}:${limit}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const wrapAndCache = (data: any) => { this.cache.set(cacheKey, data, this.RECS_TTL); return data; };

    // If logged in, find what dimensions/brands they've bought and suggest similar
    if (userId) {
      const pastOrders = await this.prisma.marketplaceOrder.findMany({
        where: { userId },
        include: { listing: { select: { marca: true, dimension: true } } },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });

      if (pastOrders.length > 0) {
        const brands = [...new Set(pastOrders.map((o) => o.listing.marca))];
        const dimensions = [...new Set(pastOrders.map((o) => o.listing.dimension))];
        const boughtIds = pastOrders.map((o) => o.listingId);

        // Find listings matching their brands or dimensions, excluding already bought
        const recommendations = await this.prisma.distributorListing.findMany({
          where: {
            isActive: true,
            id: { notIn: boughtIds },
            OR: [
              { marca: { in: brands } },
              { dimension: { in: dimensions } },
            ],
          },
          orderBy: { createdAt: 'desc' },
          take: limit,
          include: {
            distributor: { select: { id: true, slug: true, name: true, profileImage: true } },
            catalog: { select: { terreno: true, reencauchable: true, cpkEstimado: true, crowdAvgCpk: true, kmEstimadosReales: true } },
            _count: { select: { reviews: true, orders: true } },
            reviews: { select: { rating: true }, take: 10 },
          },
        });

        if (recommendations.length >= 4) {
          return wrapAndCache({ type: 'personalized' as const, listings: recommendations });
        }
      }
    }

    // Fallback: most sold items (works for guests and users with no purchase history)
    // Get listing IDs sorted by order count
    const topSold = await this.prisma.marketplaceOrder.groupBy({
      by: ['listingId'],
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: limit,
    });

    const ids = topSold.map((t) => t.listingId);

    if (ids.length === 0) {
      // No sales at all — return newest listings
      const newest = await this.prisma.distributorListing.findMany({
        where: { isActive: true },
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: {
          distributor: { select: { id: true, slug: true, name: true, profileImage: true } },
          catalog: { select: { terreno: true, reencauchable: true, cpkEstimado: true, crowdAvgCpk: true, kmEstimadosReales: true } },
          _count: { select: { reviews: true, orders: true } },
          reviews: { select: { rating: true }, take: 10 },
        },
      });
      return wrapAndCache({ type: 'newest' as const, listings: newest });
    }

    const listings = await this.prisma.distributorListing.findMany({
      where: { id: { in: ids }, isActive: true },
      include: {
        distributor: { select: { id: true, slug: true, name: true, profileImage: true } },
        catalog: { select: { terreno: true, reencauchable: true, cpkEstimado: true, crowdAvgCpk: true, kmEstimadosReales: true } },
        _count: { select: { reviews: true, orders: true } },
        reviews: { select: { rating: true }, take: 10 },
      },
    });

    // Sort by the order from topSold
    const orderMap = new Map(topSold.map((t, i) => [t.listingId, i]));
    listings.sort((a, b) => (orderMap.get(a.id) ?? 999) - (orderMap.get(b.id) ?? 999));

    return wrapAndCache({ type: 'popular' as const, listings });
  }

  async rescoreAllListings() {
    const listings = await this.prisma.distributorListing.findMany({
      where: { isActive: true },
      select: { id: true, imageUrls: true },
    });

    let updated = 0;
    for (const listing of listings) {
      const score = await this.scoreImageQuality(listing.imageUrls as string[] | null);
      await this.prisma.distributorListing.update({
        where: { id: listing.id },
        data: { imageQualityScore: score },
      });
      updated++;
    }

    this.logger.log(`Rescored ${updated} listings`);
    return { updated };
  }

  async getListingSalesCount(listingId: string): Promise<number> {
    const result = await this.prisma.marketplaceOrder.aggregate({
      where: { listingId },
      _sum: { quantity: true },
    });
    return result._sum.quantity ?? 0;
  }

  // ===========================================================================
  // DISTRIBUTOR MAP DATA
  // ===========================================================================

  async getDistributorMapData() {
    const cached = this.cache.get('distmap');
    if (cached) return cached;

    const distributors = await this.prisma.company.findMany({
      where: {
        plan: 'distribuidor',
        cobertura: { not: { equals: null } },
      },
      select: {
        id: true, slug: true, name: true, profileImage: true, colorMarca: true,
        cobertura: true, telefono: true, ciudad: true,
        _count: { select: { listings: { where: { isActive: true } } } },
        // Need each listing's dimension + tipo so we can compute the
        // category set the distributor covers (tractomula, bus, suv, etc.).
        // Filtering on isActive keeps inactive listings from inflating
        // categories the distributor no longer sells.
        listings: {
          where: { isActive: true },
          select: { dimension: true, tipo: true },
        },
      },
    });

    const filtered = distributors.filter((d) => {
      const cob = d.cobertura as any;
      return Array.isArray(cob) && cob.length > 0 && cob.some((c: any) => c.lat && c.lng);
    });

    // Categorize each distributor by what their listings cover. Categories
    // come from rim diameter (the trailing R<n> token in dimensions) plus a
    // reencauche flag, since that's the most reliable signal of vehicle
    // class without a dedicated taxonomy column.
    const result = filtered.map((d) => {
      const cats = new Set<string>();
      for (const l of d.listings ?? []) {
        if (l.tipo === 'reencauche') cats.add('reencauche');
        const dim = (l.dimension ?? '').toUpperCase();
        const rimMatch = dim.match(/R\s*(\d{2}(?:\.\d)?)/);
        const rim = rimMatch ? parseFloat(rimMatch[1]) : NaN;
        if (Number.isFinite(rim)) {
          // Heavy commercial truck/bus tires sit on 17.5"–24.5" rims. SUV
          // and pickup tires sit on 16"–18" with wider sections (265+).
          // Passenger cars use 13"–17" with sections under 245.
          if (rim >= 17.5) cats.add('tractomula');
          if (rim >= 17.5 && rim <= 22.5) cats.add('bus');
          const sectionMatch = dim.match(/^(\d{3})\//);
          const section = sectionMatch ? parseInt(sectionMatch[1], 10) : NaN;
          if (rim >= 16 && rim <= 18 && Number.isFinite(section) && section >= 245) {
            cats.add('suv');
          }
          if (rim >= 13 && rim <= 17 && Number.isFinite(section) && section < 245) {
            cats.add('automovil');
          }
        }
      }
      const { listings: _omit, ...rest } = d;
      return { ...rest, categories: [...cats].sort() };
    });

    this.cache.set('distmap', result, this.MAP_TTL);
    return result;
  }

  // ===========================================================================
  // DEADLINE ENFORCEMENT — call from cron
  // ===========================================================================

  async closeExpiredBids() {
    const now = new Date();
    const expired = await this.prisma.bidRequest.findMany({
      where: { status: BidRequestStatus.abierta, deadline: { lt: now } },
    });

    for (const bid of expired) {
      await this.prisma.$transaction([
        this.prisma.bidRequest.update({
          where: { id: bid.id },
          data: { status: BidRequestStatus.cerrada },
        }),
        this.prisma.bidResponse.updateMany({
          where: { bidRequestId: bid.id, status: BidResponseStatus.pendiente },
          data: { status: BidResponseStatus.expirada },
        }),
      ]);
    }

    if (expired.length > 0) {
      this.logger.log(`Closed ${expired.length} expired bid requests`);
    }
  }
}
