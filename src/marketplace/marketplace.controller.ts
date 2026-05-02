import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards,
  UseInterceptors, UploadedFile, Headers, Header, Req, ForbiddenException,
  HttpCode,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MarketplaceService } from './marketplace.service';
import { MarketplaceStatsService } from './marketplace-stats.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminPasswordGuard } from '../auth/guards/admin-password.guard';
import { S3Service } from '../companies/s3.service';
import { PlateLookupService } from './plate-lookup.service';
import { WompiService } from './wompi.service';

@Controller('marketplace')
export class MarketplaceController {
  constructor(
    private readonly svc: MarketplaceService,
    private readonly stats: MarketplaceStatsService,
    private readonly s3: S3Service,
    private readonly plateLookup: PlateLookupService,
    private readonly wompi: WompiService,
  ) {}

  // ===========================================================================
  // VIEW TRACKING + DISTRIBUTOR STATS
  // ===========================================================================

  /**
   * Public, fire-and-forget view tracking endpoint. Browser posts to
   * a Next.js Vercel route handler that enriches the body with geo
   * (x-vercel-ip-* headers) and forwards here. We persist the row
   * and return 204 — no data echoed back. Never errors out: a write
   * failure just drops the event silently so the browser never sees
   * a 500 on what's effectively analytics.
   */
  @Post('track/view')
  @HttpCode(204)
  async trackView(
    @Req() req: any,
    @Body() body: {
      targetType?: 'product' | 'distributor';
      targetId?: string;
      country?: string | null;
      region?: string | null;
      city?: string | null;
    },
  ): Promise<void> {
    const targetType = body?.targetType;
    const targetId   = body?.targetId;
    if (!targetType || !targetId) return;
    const ip = (req.headers?.['x-forwarded-for'] as string | undefined)
      ?.split(',')[0]?.trim()
      ?? req.ip
      ?? null;
    const userAgent = (req.headers?.['user-agent'] as string | undefined) ?? null;
    // userId may be present if the request came from a logged-in user;
    // we don't require auth, so anonymous visitors track too. The
    // frontend forwards the JWT's userId in the body when available.
    await this.stats.recordView({
      targetType, targetId,
      ip, userAgent,
      country: body?.country ?? null,
      region:  body?.region  ?? null,
      city:    body?.city    ?? null,
    });
  }

  /** Distributor stats overview. Auth → companyId from JWT.
   *  ?days=30 controls the windowed metrics (top products, top viewed). */
  @Get('dist/stats/overview')
  @UseGuards(JwtAuthGuard)
  async distStatsOverview(@Req() req: any, @Query('days') days?: string) {
    const companyId = req.user?.companyId;
    if (!companyId) throw new ForbiddenException('Auth required');
    const n = days ? Math.max(1, Math.min(365, parseInt(days, 10) || 30)) : 30;
    return this.stats.overview(companyId, n);
  }

  /** Per-product detail — views over time, geo breakdown, conversion. */
  @Get('dist/stats/product/:listingId')
  @UseGuards(JwtAuthGuard)
  async distStatsProduct(
    @Req() req: any,
    @Param('listingId') listingId: string,
    @Query('days') days?: string,
  ) {
    const companyId = req.user?.companyId;
    if (!companyId) throw new ForbiddenException('Auth required');
    const n = days ? Math.max(1, Math.min(365, parseInt(days, 10) || 30)) : 30;
    return this.stats.productDetail(companyId, listingId, n);
  }

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

  // Full history for a dist — every bid they're involved in, regardless
  // of status. The frontend tab-filters this on the dist pedidos page.
  @Get('bid-requests/distributor')
  @UseGuards(JwtAuthGuard)
  getBidsForDistributor(@Query('distributorId') distributorId: string) {
    return this.svc.getBidsForDistributor(distributorId);
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

  @Post('bid-responses/reject')
  @UseGuards(JwtAuthGuard)
  rejectBidResponse(@Body() body: {
    bidRequestId: string;
    distributorId: string;
    notas?: string;
  }) {
    return this.svc.rejectBidResponse(body);
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
      direccion: string; ciudad: string; sitioWeb: string;
      emailAtencion: string;
      emailsAtencion: string[];
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

  /**
   * Bulk-create listings from a parsed spreadsheet. Each row goes
   * through the same createListing path used for single creates, so
   * catalog SKUs auto-mint and the distributor auto-subscribes per
   * row. Errors per row don't fail the batch — we collect them and
   * return a summary so the UI can surface what didn't go through.
   */
  @Post('listings/bulk')
  @UseGuards(JwtAuthGuard)
  bulkCreateListings(@Body() body: {
    distributorId: string;
    items: Array<{
      marca: string;
      modelo: string;
      dimension: string;
      eje?: string;
      tipo?: string;
      precioCop: number;
      cantidadDisponible?: number;
      descripcion?: string;
      tiempoEntrega?: string;
    }>;
  }) {
    return this.svc.bulkCreateListings(body.distributorId, body.items);
  }

  /**
   * Preview which of this distributor's listings match a given
   * marca + modelo-substring. The frontend uses this to show "you're
   * about to update X listings" before the user confirms.
   */
  @Post('listings/preview-by-banda')
  @UseGuards(JwtAuthGuard)
  previewListingsByBanda(@Body() body: {
    distributorId: string;
    marca: string;
    modeloContains: string;
  }) {
    return this.svc.previewListingsByBanda(
      body.distributorId,
      body.marca,
      body.modeloContains,
    );
  }

  /**
   * Apply image-set + description update to every listing matching
   * marca + modelo-substring under one distributor. Saves the dist
   * from manually editing every dimension variant of the same banda.
   */
  @Patch('listings/bulk-by-banda')
  @UseGuards(JwtAuthGuard)
  bulkUpdateByBanda(@Body() body: {
    distributorId: string;
    marca: string;
    modeloContains: string;
    imageUrls?: string[];
    descripcion?: string;
  }) {
    return this.svc.bulkUpdateByBanda(body);
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

  /**
   * Public-but-gated order tracking lookup. The frontend tracking page
   * (/marketplace/order/<id>) hits this. Returns order details only
   * when the provided email matches the order's buyerEmail (case- and
   * whitespace-insensitive). No JWT required — the tokenized email
   * serves as the bearer for guest checkouts; logged-in users supply
   * their own email and the same equality check applies.
   */
  @Get('orders/:id/track')
  trackOrder(
    @Param('id') id: string,
    @Query('email') email: string,
  ) {
    return this.svc.trackOrder(id, email);
  }

  @Patch('orders/:id/status')
  @UseGuards(JwtAuthGuard)
  updateOrderStatus(
    @Param('id') id: string,
    @Body() body: {
      distributorId: string;
      status: string;
      cancelReason?: string;
      etaDate?: string | null;
      /** Free-form note attached to this status entry — visible to the buyer */
      note?: string;
    },
  ) {
    return this.svc.updateOrderStatus(
      id, body.distributorId, body.status, body.cancelReason, body.etaDate, body.note,
    );
  }

  /**
   * Buyer submits a delivery survey (rating + optional comment).
   * Email-gated: the submitter's email must match the order's buyerEmail.
   * Idempotent — repeated submissions update the prior survey in place.
   */
  @Post('orders/:id/survey')
  submitOrderSurvey(
    @Param('id') id: string,
    @Body() body: { email: string; rating: number; comment?: string },
  ) {
    return this.svc.submitOrderSurvey(id, body.email, body.rating, body.comment);
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
