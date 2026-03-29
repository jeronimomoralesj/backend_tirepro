import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards,
} from '@nestjs/common';
import { MarketplaceService } from './marketplace.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('marketplace')
export class MarketplaceController {
  constructor(private readonly svc: MarketplaceService) {}

  // ===========================================================================
  // BID REQUESTS — Pro company
  // ===========================================================================

  @Post('bid-requests')
  @UseGuards(JwtAuthGuard)
  createBidRequest(@Body() body: {
    companyId: string;
    items: any[];
    totalEstimado?: number;
    notas?: string;
    deliveryAddress?: string;
    deadline?: string;
    distributorIds: string[];
    isPublic?: boolean;
  }) {
    return this.svc.createBidRequest(body);
  }

  @Get('bid-requests/company')
  @UseGuards(JwtAuthGuard)
  getCompanyBidRequests(@Query('companyId') companyId: string) {
    return this.svc.getCompanyBidRequests(companyId);
  }

  @Get('bid-requests/available')
  @UseGuards(JwtAuthGuard)
  getAvailableBids(@Query('distributorId') distributorId: string) {
    return this.svc.getAvailableBids(distributorId);
  }

  @Get('bid-requests/:id')
  @UseGuards(JwtAuthGuard)
  getBidRequest(@Param('id') id: string) {
    return this.svc.getBidRequestById(id);
  }

  @Patch('bid-requests/:id/award')
  @UseGuards(JwtAuthGuard)
  awardBid(
    @Param('id') id: string,
    @Body() body: { distributorId: string; companyId: string },
  ) {
    return this.svc.awardBid(id, body.distributorId, body.companyId);
  }

  @Patch('bid-requests/:id/cancel')
  @UseGuards(JwtAuthGuard)
  cancelBidRequest(
    @Param('id') id: string,
    @Body() body: { companyId: string },
  ) {
    return this.svc.cancelBidRequest(id, body.companyId);
  }

  // ===========================================================================
  // BID RESPONSES — Distributor
  // ===========================================================================

  @Post('bid-responses')
  @UseGuards(JwtAuthGuard)
  submitBidResponse(@Body() body: {
    bidRequestId: string;
    distributorId: string;
    cotizacion: any[];
    totalCotizado: number;
    notas?: string;
    incluyeIva?: boolean;
    tiempoEntrega?: string;
  }) {
    return this.svc.submitBidResponse(body);
  }

  // ===========================================================================
  // LISTINGS — Ecommerce
  // ===========================================================================

  @Get('listings')
  searchListings(
    @Query('dimension') dimension?: string,
    @Query('marca') marca?: string,
    @Query('eje') eje?: string,
    @Query('minPrice') minPrice?: string,
    @Query('maxPrice') maxPrice?: string,
    @Query('search') search?: string,
    @Query('sortBy') sortBy?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.searchListings({
      dimension, marca, eje, search, sortBy,
      minPrice: minPrice ? Number(minPrice) : undefined,
      maxPrice: maxPrice ? Number(maxPrice) : undefined,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('listings/filters')
  getFilters() {
    return this.svc.getMarketplaceFilters();
  }

  @Get('listings/distributor')
  @UseGuards(JwtAuthGuard)
  getDistributorListings(@Query('distributorId') distributorId: string) {
    return this.svc.getDistributorListings(distributorId);
  }

  @Post('listings')
  @UseGuards(JwtAuthGuard)
  createListing(@Body() body: {
    distributorId: string;
    catalogId?: string;
    marca: string;
    modelo: string;
    dimension: string;
    eje?: string;
    precioCop: number;
    precioPromo?: number;
    promoHasta?: string;
    incluyeIva?: boolean;
    cantidadDisponible?: number;
    tiempoEntrega?: string;
    descripcion?: string;
    imageUrl?: string;
  }) {
    return this.svc.createListing(body);
  }

  @Patch('listings/:id')
  @UseGuards(JwtAuthGuard)
  updateListing(
    @Param('id') id: string,
    @Body() body: { distributorId: string } & Partial<{
      precioCop: number;
      precioPromo: number | null;
      promoHasta: string | null;
      cantidadDisponible: number;
      tiempoEntrega: string;
      descripcion: string;
      imageUrl: string;
      isActive: boolean;
    }>,
  ) {
    const { distributorId, ...data } = body;
    return this.svc.updateListing(id, distributorId, data);
  }

  @Delete('listings/:id')
  @UseGuards(JwtAuthGuard)
  deleteListing(
    @Param('id') id: string,
    @Body() body: { distributorId: string },
  ) {
    return this.svc.deleteListing(id, body.distributorId);
  }
}
