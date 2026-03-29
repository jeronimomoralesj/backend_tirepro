import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BidRequestStatus, BidResponseStatus } from '@prisma/client';

@Injectable()
export class MarketplaceService {
  private readonly logger = new Logger(MarketplaceService.name);

  constructor(private readonly prisma: PrismaService) {}

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
    const where: any = { isActive: true, cantidadDisponible: { gt: 0 } };

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
        imageUrls: data.imageUrls ?? null,
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
        where: { isActive: true, cantidadDisponible: { gt: 0 } },
        select: { dimension: true },
        distinct: ['dimension'],
        orderBy: { dimension: 'asc' },
      }),
      this.prisma.distributorListing.findMany({
        where: { isActive: true, cantidadDisponible: { gt: 0 } },
        select: { marca: true },
        distinct: ['marca'],
        orderBy: { marca: 'asc' },
      }),
      this.prisma.distributorListing.findMany({
        where: { isActive: true, cantidadDisponible: { gt: 0 } },
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
