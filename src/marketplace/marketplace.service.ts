import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BidRequestStatus, BidResponseStatus } from '@prisma/client';
import { EmailService } from '../email/email.service';

@Injectable()
export class MarketplaceService {
  private readonly logger = new Logger(MarketplaceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

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
    sortBy?: string;
    page?: number;
    limit?: number;
  }) {
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

    const orderBy: any = {};
    switch (filters.sortBy) {
      case 'price_asc': orderBy.precioCop = 'asc'; break;
      case 'price_desc': orderBy.precioCop = 'desc'; break;
      case 'newest': orderBy.createdAt = 'desc'; break;
      default: orderBy.precioCop = 'asc';
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
          reviews: { select: { rating: true }, take: 100 },
        },
      }),
      this.prisma.distributorListing.count({ where }),
    ]);

    return { listings, total, page, limit, pages: Math.ceil(total / limit) };
  }

  async getDistributorListings(distributorId: string) {
    return this.prisma.distributorListing.findMany({
      where: { distributorId },
      orderBy: { updatedAt: 'desc' },
      include: {
        catalog: { select: { id: true, skuRef: true, marca: true, modelo: true, dimension: true } },
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
      },
    });
  }

  async updateListing(id: string, distributorId: string, data: Partial<{
    precioCop: number;
    precioPromo: number | null;
    promoHasta: string | null;
    cantidadDisponible: number;
    tiempoEntrega: string;
    descripcion: string;
    imageUrl: string;
    isActive: boolean;
  }>) {
    const listing = await this.prisma.distributorListing.findUnique({ where: { id } });
    if (!listing) throw new NotFoundException('Listing not found');
    if (listing.distributorId !== distributorId) throw new BadRequestException('Not your listing');

    const updateData: any = { ...data };
    if (data.promoHasta !== undefined) {
      updateData.promoHasta = data.promoHasta ? new Date(data.promoHasta) : null;
    }

    return this.prisma.distributorListing.update({ where: { id }, data: updateData });
  }

  async deleteListing(id: string, distributorId: string) {
    const listing = await this.prisma.distributorListing.findUnique({ where: { id } });
    if (!listing) throw new NotFoundException('Listing not found');
    if (listing.distributorId !== distributorId) throw new BadRequestException('Not your listing');

    return this.prisma.distributorListing.update({
      where: { id },
      data: { isActive: false },
    });
  }

  // ===========================================================================
  // MARKETPLACE FILTERS — for dropdown population
  // ===========================================================================

  async getMarketplaceFilters() {
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

    return {
      dimensions: dimensions.map((d) => d.dimension),
      marcas: marcas.map((m) => m.marca),
      distributors,
    };
  }

  // ===========================================================================
  // DISTRIBUTOR PUBLIC PROFILE
  // ===========================================================================

  async getDistributorProfile(distributorId: string) {
    const company = await this.prisma.company.findUnique({
      where: { id: distributorId },
      select: {
        id: true, name: true, profileImage: true, plan: true,
        emailAtencion: true, telefono: true, descripcion: true,
        bannerImage: true, direccion: true, ciudad: true, sitioWeb: true,
        cobertura: true, tipoEntrega: true,
        _count: { select: { listings: { where: { isActive: true } } } },
      },
    });
    if (!company) throw new NotFoundException('Distributor not found');
    return company;
  }

  async updateDistributorProfile(distributorId: string, data: Partial<{
    telefono: string; descripcion: string; bannerImage: string;
    direccion: string; ciudad: string; sitioWeb: string; emailAtencion: string;
    cobertura: string[]; tipoEntrega: string;
  }>) {
    return this.prisma.company.update({ where: { id: distributorId }, data });
  }

  // ===========================================================================
  // REVIEWS
  // ===========================================================================

  async createReview(data: { listingId: string; userId: string; rating: number; comment?: string }) {
    if (data.rating < 1 || data.rating > 5) throw new BadRequestException('Rating must be 1-5');

    return this.prisma.distributorReview.upsert({
      where: { listingId_userId: { listingId: data.listingId, userId: data.userId } },
      create: { listingId: data.listingId, userId: data.userId, rating: data.rating, comment: data.comment ?? null },
      update: { rating: data.rating, comment: data.comment ?? null },
    });
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

    return { ...listing, totalSold: salesCount._sum.quantity ?? 0 };
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

    return order;
  }

  async getDistributorOrders(distributorId: string) {
    return this.prisma.marketplaceOrder.findMany({
      where: { distributorId },
      orderBy: { createdAt: 'desc' },
      include: { listing: { select: { marca: true, modelo: true, dimension: true, imageUrls: true, coverIndex: true } } },
    });
  }

  async updateOrderStatus(orderId: string, distributorId: string, status: string) {
    const order = await this.prisma.marketplaceOrder.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.distributorId !== distributorId) throw new BadRequestException('Not your order');
    return this.prisma.marketplaceOrder.update({ where: { id: orderId }, data: { status } });
  }

  async getDistributorSalesStats(distributorId: string) {
    const [orders, totalRevenue, totalSold, byListing, byMonth] = await Promise.all([
      this.prisma.marketplaceOrder.count({ where: { distributorId } }),
      this.prisma.marketplaceOrder.aggregate({ where: { distributorId }, _sum: { totalCop: true } }),
      this.prisma.marketplaceOrder.aggregate({ where: { distributorId }, _sum: { quantity: true } }),
      this.prisma.marketplaceOrder.groupBy({
        by: ['listingId'],
        where: { distributorId },
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
        WHERE "distributorId" = ${distributorId}
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
      topListings: byListing.map((l) => ({
        listing: listingMap.get(l.listingId) ?? { marca: '?', modelo: '?', dimension: '?' },
        orders: l._count,
        unitsSold: l._sum.quantity ?? 0,
        revenue: l._sum.totalCop ?? 0,
      })),
      monthlyStats: byMonth,
    };
  }

  async getListingSalesCount(listingId: string): Promise<number> {
    const result = await this.prisma.marketplaceOrder.aggregate({
      where: { listingId },
      _sum: { quantity: true },
    });
    return result._sum.quantity ?? 0;
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
