import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BidRequestStatus, BidResponseStatus } from '@prisma/client';
import { EmailService } from '../email/email.service';

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

    const bidRequest = await this.prisma.bidRequest.create({
      data: {
        companyId,
        items: items as any,
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
            distributor: { select: { id: true, name: true, profileImage: true } },
          },
        },
        invitations: {
          include: {
            distributor: { select: { id: true, name: true } },
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
            distributor: { select: { id: true, name: true, profileImage: true } },
          },
        },
        invitations: {
          include: {
            distributor: { select: { id: true, name: true } },
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

    // Award winner, reject others
    await this.prisma.$transaction([
      this.prisma.bidResponse.update({
        where: { id: winningResponse.id },
        data: { status: BidResponseStatus.ganadora },
      }),
      this.prisma.bidResponse.updateMany({
        where: { bidRequestId, id: { not: winningResponse.id } },
        data: { status: BidResponseStatus.rechazada },
      }),
      this.prisma.bidRequest.update({
        where: { id: bidRequestId },
        data: {
          status: BidRequestStatus.adjudicada,
          winnerId: distributorId,
          resolvedAt: new Date(),
        },
      }),
    ]);

    return this.getBidRequestById(bidRequestId);
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
        status: BidRequestStatus.abierta,
        OR: [
          { invitations: { some: { distributorId } } },
          { isPublic: true },
        ],
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

  // ===========================================================================
  // DISTRIBUTOR LISTINGS — Ecommerce
  // ===========================================================================

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
      where.OR = [
        { marca: { contains: filters.search, mode: 'insensitive' } },
        { modelo: { contains: filters.search, mode: 'insensitive' } },
        { dimension: { contains: filters.search, mode: 'insensitive' } },
        { distributor: { name: { contains: filters.search, mode: 'insensitive' } } },
      ];
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
        // If a search is also active, AND the two OR groups together.
        if (where.OR) {
          where.AND = [{ OR: where.OR }, { OR: rimOr }];
          delete where.OR;
        } else {
          where.OR = rimOr;
        }
      }
    }

    let orderBy: any;
    switch (filters.sortBy) {
      case 'price_asc': orderBy = { precioCop: 'asc' }; break;
      case 'price_desc': orderBy = { precioCop: 'desc' }; break;
      case 'newest': orderBy = { createdAt: 'desc' }; break;
      // Default: relevance = image quality first, then newest
      default: orderBy = [{ imageQualityScore: 'desc' }, { createdAt: 'desc' }];
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
          distributor: { select: { id: true, name: true, profileImage: true } },
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
    // Auto-link to catalog by marca+modelo+dimension
    if (!data.catalogId && data.marca && data.modelo && data.dimension) {
      const catalog = await this.prisma.tireMasterCatalog.findFirst({
        where: { marca: { equals: data.marca, mode: 'insensitive' }, modelo: { equals: data.modelo, mode: 'insensitive' }, dimension: data.dimension },
      });
      if (catalog) data.catalogId = catalog.id;
    }
    // If catalogId provided, enrich from catalog
    if (data.catalogId) {
      const catalog = await this.prisma.tireMasterCatalog.findUnique({ where: { id: data.catalogId } });
      if (catalog) {
        data.marca = data.marca || catalog.marca;
        data.modelo = data.modelo || catalog.modelo;
        data.dimension = data.dimension || catalog.dimension;
      }
    }

    const imageQualityScore = await this.scoreImageQuality(data.imageUrls ?? null);

    return this.prisma.distributorListing.create({
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
    this.invalidateListingCaches();
    return result;
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
          select: { id: true, name: true, profileImage: true },
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

  async getDistributorProfile(distributorId: string) {
    const cacheKey = `distprofile:${distributorId}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const company = await this.prisma.company.findUnique({
      where: { id: distributorId },
      select: {
        id: true, name: true, profileImage: true, plan: true,
        emailAtencion: true, telefono: true, descripcion: true,
        bannerImage: true, direccion: true, ciudad: true, sitioWeb: true,
        cobertura: true, tipoEntrega: true, colorMarca: true,
        _count: { select: { listings: { where: { isActive: true } } } },
      },
    });
    if (!company) throw new NotFoundException('Distributor not found');
    this.cache.set(cacheKey, company, this.PROFILE_TTL);
    return company;
  }

  async updateDistributorProfile(distributorId: string, data: Partial<{
    telefono: string; descripcion: string; bannerImage: string;
    direccion: string; ciudad: string; sitioWeb: string; emailAtencion: string;
    cobertura: any[]; tipoEntrega: string; colorMarca: string;
  }>) {
    const result = await this.prisma.company.update({ where: { id: distributorId }, data });
    this.cache.invalidate(`distprofile:${distributorId}`);
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
        distributor: { select: { id: true, name: true, profileImage: true, ciudad: true, telefono: true, emailAtencion: true, tipoEntrega: true, cobertura: true } },
        catalog: { select: { id: true, skuRef: true, terreno: true, reencauchable: true, kmEstimadosReales: true, cpkEstimado: true, crowdAvgCpk: true, psiRecomendado: true, rtdMm: true } },
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
      include: { distributor: { select: { id: true, name: true, emailAtencion: true } } },
    });
    if (!listing) throw new NotFoundException('Listing not found');

    const totalCop = listing.precioCop * data.quantity;

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
      },
      include: { listing: true },
    });

    // Send confirmation email to buyer
    try {
      const fmtCOP = (n: number) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n);
      await this.email.sendEmail(data.buyerEmail, `Pedido confirmado — ${listing.marca} ${listing.modelo}`, `
        <div style="font-family:system-ui;max-width:600px;margin:0 auto">
          <div style="background:linear-gradient(135deg,#0A183A,#1E76B6);color:white;padding:30px;border-radius:12px 12px 0 0">
            <h1 style="margin:0;font-size:20px">Pedido Confirmado</h1>
            <p style="margin:4px 0 0;opacity:0.7;font-size:13px">TirePro Marketplace</p>
          </div>
          <div style="padding:24px;background:white;border:1px solid #e5e5e5;border-top:0;border-radius:0 0 12px 12px">
            <p style="margin:0 0 16px;color:#333">Hola <strong>${data.buyerName}</strong>,</p>
            <p style="margin:0 0 20px;color:#555;font-size:14px">Tu pedido ha sido recibido. El distribuidor se comunicara contigo para coordinar la entrega.</p>
            <div style="background:#f5f5f7;padding:16px;border-radius:8px;margin-bottom:20px">
              <p style="margin:0 0 8px;font-weight:700;color:#0A183A">${listing.marca} ${listing.modelo}</p>
              <p style="margin:0 0 4px;font-size:13px;color:#666">${listing.dimension}</p>
              <p style="margin:0 0 4px;font-size:13px;color:#666">Cantidad: ${data.quantity}</p>
              <p style="margin:12px 0 0;font-size:18px;font-weight:800;color:#0A183A">${fmtCOP(totalCop)}</p>
            </div>
            <p style="margin:0 0 4px;font-size:13px;color:#666"><strong>Distribuidor:</strong> ${listing.distributor.name}</p>
            <p style="margin:0 0 4px;font-size:13px;color:#666"><strong>Pedido:</strong> #${order.id.slice(0, 8).toUpperCase()}</p>
            ${data.buyerAddress ? `<p style="margin:0 0 4px;font-size:13px;color:#666"><strong>Entrega:</strong> ${data.buyerAddress}${data.buyerCity ? ', ' + data.buyerCity : ''}</p>` : ''}
            <hr style="border:none;border-top:1px solid #eee;margin:20px 0"/>
            <p style="margin:0;font-size:12px;color:#999">Este email fue enviado por TirePro Marketplace — tirepro.com.co</p>
          </div>
        </div>
      `);
    } catch (err) {
      this.logger.warn(`Failed to send order confirmation: ${err}`);
    }

    // Notify distributor
    try {
      const distEmail = listing.distributor.emailAtencion;
      if (distEmail) {
        const fmtCOP = (n: number) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n);
        await this.email.sendEmail(distEmail, `Nuevo pedido — ${listing.marca} ${listing.modelo}`, `
          <div style="font-family:system-ui;max-width:600px;margin:0 auto">
            <div style="background:linear-gradient(135deg,#0A183A,#1E76B6);color:white;padding:30px;border-radius:12px 12px 0 0">
              <h1 style="margin:0;font-size:20px">Nuevo Pedido del Marketplace</h1>
            </div>
            <div style="padding:24px;background:white;border:1px solid #e5e5e5;border-top:0;border-radius:0 0 12px 12px">
              <div style="background:#f5f5f7;padding:16px;border-radius:8px;margin-bottom:16px">
                <p style="margin:0 0 8px;font-weight:700;color:#0A183A">${listing.marca} ${listing.modelo} · ${listing.dimension}</p>
                <p style="margin:0;font-size:13px;color:#666">Cantidad: ${data.quantity} · Total: ${fmtCOP(totalCop)}</p>
              </div>
              <p style="margin:0 0 8px;font-size:14px;font-weight:700;color:#0A183A">Datos del comprador:</p>
              <p style="margin:0 0 4px;font-size:13px;color:#666"><strong>Nombre:</strong> ${data.buyerName}</p>
              <p style="margin:0 0 4px;font-size:13px;color:#666"><strong>Email:</strong> ${data.buyerEmail}</p>
              ${data.buyerPhone ? `<p style="margin:0 0 4px;font-size:13px;color:#666"><strong>Telefono:</strong> ${data.buyerPhone}</p>` : ''}
              ${data.buyerAddress ? `<p style="margin:0 0 4px;font-size:13px;color:#666"><strong>Direccion:</strong> ${data.buyerAddress}${data.buyerCity ? ', ' + data.buyerCity : ''}</p>` : ''}
              ${data.buyerCompany ? `<p style="margin:0 0 4px;font-size:13px;color:#666"><strong>Empresa:</strong> ${data.buyerCompany}</p>` : ''}
              ${data.notas ? `<p style="margin:0 0 4px;font-size:13px;color:#666"><strong>Notas:</strong> ${data.notas}</p>` : ''}
            </div>
          </div>
        `);
      }
    } catch (err) {
      this.logger.warn(`Failed to send distributor notification: ${err}`);
    }

    this.cache.invalidate(`product:${data.listingId}`);
    this.cache.invalidate('recs:');
    return order;
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

  async updateOrderStatus(orderId: string, distributorId: string, status: string, cancelReason?: string) {
    const order = await this.prisma.marketplaceOrder.findUnique({
      where: { id: orderId },
      include: { listing: { select: { marca: true, modelo: true, dimension: true } } },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.distributorId !== distributorId) throw new BadRequestException('Not your order');

    const updated = await this.prisma.marketplaceOrder.update({
      where: { id: orderId },
      data: { status, ...(cancelReason ? { notas: `[CANCELADO] ${cancelReason}${order.notas ? ` | Original: ${order.notas}` : ''}` } : {}) },
    });

    // Send cancellation email to buyer
    if (status === 'cancelado' && order.buyerEmail) {
      this.logger.log(`Sending cancellation email to ${order.buyerEmail} for order ${orderId}, reason: ${cancelReason}`);
      try {
        const dist = await this.prisma.company.findUnique({ where: { id: distributorId }, select: { name: true } });
        const fmtCOP = (n: number) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n);
        await this.email.sendEmail(order.buyerEmail, `Pedido cancelado — ${order.listing.marca} ${order.listing.modelo}`, `
          <div style="font-family:system-ui;max-width:600px;margin:0 auto">
            <div style="background:linear-gradient(135deg,#991b1b,#ef4444);color:white;padding:30px;border-radius:12px 12px 0 0">
              <h1 style="margin:0;font-size:20px">Pedido Cancelado</h1>
              <p style="margin:4px 0 0;opacity:0.7;font-size:13px">TirePro Marketplace</p>
            </div>
            <div style="padding:24px;background:white;border:1px solid #e5e5e5;border-top:0;border-radius:0 0 12px 12px">
              <p style="margin:0 0 16px;color:#333">Hola <strong>${order.buyerName}</strong>,</p>
              <p style="margin:0 0 16px;color:#555;font-size:14px">Lamentamos informarte que tu pedido ha sido cancelado por el distribuidor.</p>
              <div style="background:#fef2f2;padding:16px;border-radius:8px;margin-bottom:16px;border-left:4px solid #ef4444">
                <p style="margin:0 0 4px;font-weight:700;color:#991b1b;font-size:13px">Motivo de cancelacion:</p>
                <p style="margin:0;color:#7f1d1d;font-size:13px">${cancelReason ?? 'No especificado'}</p>
              </div>
              <div style="background:#f5f5f7;padding:16px;border-radius:8px;margin-bottom:16px">
                <p style="margin:0 0 8px;font-weight:700;color:#0A183A">${order.listing.marca} ${order.listing.modelo}</p>
                <p style="margin:0 0 4px;font-size:13px;color:#666">${order.listing.dimension} · Cantidad: ${order.quantity}</p>
                <p style="margin:0;font-size:13px;color:#666">Total: ${fmtCOP(order.totalCop)}</p>
              </div>
              <p style="margin:0 0 4px;font-size:13px;color:#666"><strong>Distribuidor:</strong> ${dist?.name ?? 'Distribuidor'}</p>
              <p style="margin:0 0 4px;font-size:13px;color:#666"><strong>Pedido:</strong> #${orderId.slice(0, 8).toUpperCase()}</p>
              <hr style="border:none;border-top:1px solid #eee;margin:20px 0"/>
              <p style="margin:0 0 8px;font-size:14px;color:#333">Puedes buscar este producto con otros distribuidores en el marketplace:</p>
              <a href="https://tirepro.com.co/marketplace" style="display:inline-block;padding:10px 24px;border-radius:8px;background:#1E76B6;color:white;font-size:13px;font-weight:700;text-decoration:none">Ver Marketplace</a>
              <hr style="border:none;border-top:1px solid #eee;margin:20px 0"/>
              <p style="margin:0;font-size:12px;color:#999">TirePro Marketplace — tirepro.com.co</p>
            </div>
          </div>
        `);
        this.logger.log(`Cancellation email sent successfully to ${order.buyerEmail}`);
      } catch (err) {
        this.logger.error(`Failed to send cancellation email to ${order.buyerEmail}: ${err?.message ?? err}`);
      }
    }

    // Send confirmation email when status changes to confirmado
    if (status === 'confirmado' && order.buyerEmail) {
      try {
        const dist = await this.prisma.company.findUnique({ where: { id: distributorId }, select: { name: true, telefono: true } });
        await this.email.sendEmail(order.buyerEmail, `Pedido confirmado — ${order.listing.marca} ${order.listing.modelo}`, `
          <div style="font-family:system-ui;max-width:600px;margin:0 auto">
            <div style="background:linear-gradient(135deg,#0A183A,#1E76B6);color:white;padding:30px;border-radius:12px 12px 0 0">
              <h1 style="margin:0;font-size:20px">Pedido Confirmado por Distribuidor</h1>
            </div>
            <div style="padding:24px;background:white;border:1px solid #e5e5e5;border-top:0;border-radius:0 0 12px 12px">
              <p style="margin:0 0 16px;color:#333">Hola <strong>${order.buyerName}</strong>,</p>
              <p style="margin:0 0 16px;color:#555;font-size:14px">${dist?.name ?? 'El distribuidor'} ha confirmado tu pedido. Se comunicaran contigo para coordinar la entrega.</p>
              <div style="background:#f0f7ff;padding:16px;border-radius:8px">
                <p style="margin:0 0 4px;font-weight:700;color:#0A183A">${order.listing.marca} ${order.listing.modelo} · ${order.listing.dimension}</p>
                <p style="margin:0;font-size:13px;color:#666">Pedido #${orderId.slice(0, 8).toUpperCase()}</p>
                ${dist?.telefono ? `<p style="margin:8px 0 0;font-size:13px;color:#1E76B6;font-weight:700">Telefono: ${dist.telefono}</p>` : ''}
              </div>
            </div>
          </div>
        `);
      } catch (err) { this.logger.warn(`Failed to send confirmation email: ${err}`); }
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
            distributor: { select: { id: true, name: true, profileImage: true } },
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
          distributor: { select: { id: true, name: true, profileImage: true } },
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
        distributor: { select: { id: true, name: true, profileImage: true } },
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
        id: true, name: true, profileImage: true, colorMarca: true,
        cobertura: true, telefono: true, ciudad: true,
        _count: { select: { listings: { where: { isActive: true } } } },
      },
    });
    const result = distributors.filter((d) => {
      const cob = d.cobertura as any;
      return Array.isArray(cob) && cob.length > 0 && cob.some((c: any) => c.lat && c.lng);
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
