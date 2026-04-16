import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards,
  UseInterceptors, UploadedFile, Headers, Header,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MarketplaceService } from './marketplace.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminPasswordGuard } from '../auth/guards/admin-password.guard';
import { S3Service } from '../companies/s3.service';
import { PlateLookupService } from './plate-lookup.service';
import { WompiService } from './wompi.service';

@Controller('marketplace')
export class MarketplaceController {
  constructor(
    private readonly svc: MarketplaceService,
    private readonly s3: S3Service,
    private readonly plateLookup: PlateLookupService,
    private readonly wompi: WompiService,
  ) {}

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
  @Header('Cache-Control', 'public, max-age=60, stale-while-revalidate=120')
  searchListings(
    @Query('dimension') dimension?: string,
    @Query('marca') marca?: string,
    @Query('eje') eje?: string,
    @Query('tipo') tipo?: string,
    @Query('distributorId') distributorId?: string,
    @Query('ciudad') ciudad?: string,
    @Query('minPrice') minPrice?: string,
    @Query('maxPrice') maxPrice?: string,
    @Query('search') search?: string,
    @Query('rimSizes') rimSizes?: string,
    @Query('sortBy') sortBy?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.searchListings({
      dimension, marca, eje, tipo, distributorId, ciudad, search, rimSizes, sortBy,
      minPrice: minPrice ? Number(minPrice) : undefined,
      maxPrice: maxPrice ? Number(maxPrice) : undefined,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('listings/filters')
  @Header('Cache-Control', 'public, max-age=300, stale-while-revalidate=600')
  getFilters() {
    return this.svc.getMarketplaceFilters();
  }

  @Get('distributor/:id/profile')
  @Header('Cache-Control', 'public, max-age=300, stale-while-revalidate=600')
  getDistributorProfile(@Param('id') id: string) {
    return this.svc.getDistributorProfile(id);
  }

  @Patch('distributor/:id/profile')
  @UseGuards(JwtAuthGuard)
  updateDistributorProfile(
    @Param('id') id: string,
    @Body() body: Partial<{
      telefono: string; descripcion: string; bannerImage: string;
      direccion: string; ciudad: string; sitioWeb: string; emailAtencion: string;
    }>,
  ) {
    return this.svc.updateDistributorProfile(id, body);
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

  // ===========================================================================
  // IMAGE UPLOAD
  // ===========================================================================

  @Post('upload')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('image'))
  async uploadImage(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { distributorId: string },
  ) {
    if (!file) throw new Error('No file provided');
    const url = await this.s3.uploadMarketplaceImage(
      file.buffer, body.distributorId, file.mimetype,
    );
    return { url };
  }

  // ===========================================================================
  // REVIEWS
  // ===========================================================================

  @Get('listings/:id/reviews')
  getReviews(@Param('id') id: string) {
    return this.svc.getListingReviews(id);
  }

  @Post('listings/:id/reviews')
  @UseGuards(JwtAuthGuard)
  createReview(
    @Param('id') listingId: string,
    @Body() body: { userId: string; rating: number; comment?: string },
  ) {
    return this.svc.createReview({ listingId, ...body });
  }

  // ===========================================================================
  // SINGLE LISTING (product detail)
  // ===========================================================================

  @Get('product/:id')
  @Header('Cache-Control', 'public, max-age=180, stale-while-revalidate=600')
  getProduct(@Param('id') id: string) {
    return this.svc.getListingById(id);
  }

  // ===========================================================================
  // MARKETPLACE ORDERS
  // ===========================================================================

  @Post('orders')
  createOrder(@Body() body: {
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
    return this.svc.createOrder(body);
  }

  @Get('orders/distributor')
  @UseGuards(JwtAuthGuard)
  getDistributorOrders(@Query('distributorId') distributorId: string) {
    return this.svc.getDistributorOrders(distributorId);
  }

  @Patch('orders/:id/status')
  @UseGuards(JwtAuthGuard)
  updateOrderStatus(
    @Param('id') id: string,
    @Body() body: { distributorId: string; status: string; cancelReason?: string },
  ) {
    return this.svc.updateOrderStatus(id, body.distributorId, body.status, body.cancelReason);
  }

  // Buyer requests a return on a delivered/shipped order
  @Post('orders/:id/return-request')
  @UseGuards(JwtAuthGuard)
  requestOrderReturn(
    @Param('id') id: string,
    @Body() body: { userId: string; reason: string },
  ) {
    return this.svc.requestOrderReturn(id, body.userId, body.reason);
  }

  // Distributor approves or rejects a pending return request
  @Patch('orders/:id/return-status')
  @UseGuards(JwtAuthGuard)
  updateOrderReturnStatus(
    @Param('id') id: string,
    @Body() body: { distributorId: string; returnStatus: 'aprobada' | 'rechazada' },
  ) {
    return this.svc.updateOrderReturnStatus(id, body.distributorId, body.returnStatus);
  }

  @Get('sales/distributor')
  @UseGuards(JwtAuthGuard)
  getDistributorSales(@Query('distributorId') distributorId: string) {
    return this.svc.getDistributorSalesStats(distributorId);
  }

  @Get('orders/user')
  @UseGuards(JwtAuthGuard)
  getUserOrders(@Query('userId') userId: string) {
    return this.svc.getUserRecentOrders(userId);
  }

  @Post('rescore-images')
  @UseGuards(JwtAuthGuard)
  rescoreImages() {
    return this.svc.rescoreAllListings();
  }

  @Get('plate-lookup/:placa')
  lookupPlate(@Param('placa') placa: string) {
    return this.plateLookup.lookupPlate(placa);
  }

  @Post('plate-lookup/:placa/community')
  saveCommunityPlate(
    @Param('placa') placa: string,
    @Body('clase') clase: string,
  ) {
    return this.plateLookup.saveCommunityLookup(placa, clase);
  }

  @Get('distributors/map')
  @Header('Cache-Control', 'public, max-age=600, stale-while-revalidate=1200')
  getDistributorMap() {
    return this.svc.getDistributorMapData();
  }

  // -- Brand pages ----------------------------------------------------------
  @Get('brands')
  @Header('Cache-Control', 'public, max-age=900, stale-while-revalidate=1800')
  listBrands() {
    return this.svc.listBrands();
  }

  @Get('brands/:slug')
  @Header('Cache-Control', 'public, max-age=900, stale-while-revalidate=1800')
  getBrand(@Param('slug') slug: string) {
    return this.svc.getBrandBySlug(slug);
  }

  @Post('brands/cache/invalidate')
  invalidateBrandCache() {
    this.svc.invalidateBrandCaches();
    return { ok: true };
  }

  // -- Admin brand editor ---------------------------------------------------

  @Get('admin/brands')
  @UseGuards(AdminPasswordGuard)
  adminListBrands() {
    return this.svc.adminListBrands();
  }

  @Get('admin/brands/:id')
  @UseGuards(AdminPasswordGuard)
  adminGetBrand(@Param('id') id: string) {
    return this.svc.adminGetBrand(id);
  }

  @Post('admin/brands')
  @UseGuards(AdminPasswordGuard)
  adminCreateBrand(@Body() body: any) {
    const { __adminPassword, ...data } = body ?? {};
    return this.svc.adminCreateBrand(data);
  }

  @Patch('admin/brands/:id')
  @UseGuards(AdminPasswordGuard)
  adminUpdateBrand(@Param('id') id: string, @Body() body: any) {
    const { __adminPassword, ...data } = body ?? {};
    return this.svc.adminUpdateBrand(id, data);
  }

  @Delete('admin/brands/:id')
  @UseGuards(AdminPasswordGuard)
  adminDeleteBrand(@Param('id') id: string) {
    return this.svc.adminDeleteBrand(id);
  }

  @Get('recommendations')
  @Header('Cache-Control', 'public, max-age=300, stale-while-revalidate=600')
  getRecommendations(@Query('userId') userId?: string) {
    return this.svc.getRecommendations(userId || undefined);
  }

  @Get('sales/listing/:id')
  getListingSales(@Param('id') id: string) {
    return this.svc.getListingSalesCount(id);
  }

  // ===========================================================================
  // WOMPI PAYMENTS
  // ===========================================================================

  /** Generate integrity signature for Wompi widget */
  @Post('payments/integrity')
  getIntegritySignature(@Body() body: { reference: string; amountInCents: number; currency?: string }) {
    const signature = this.wompi.generateIntegritySignature(
      body.reference, body.amountInCents, body.currency ?? 'COP',
    );
    return { signature };
  }

  /** Wompi webhook — receives payment status updates */
  @Post('payments/webhook')
  async wompiWebhook(
    @Body() body: any,
    @Headers('x-event-checksum') checksum: string,
  ) {
    return this.wompi.handleWebhookEvent(body);
  }

  /** Check transaction status */
  @Get('payments/transaction/:id')
  getTransactionStatus(@Param('id') id: string) {
    return this.wompi.getTransactionStatus(id);
  }
}
