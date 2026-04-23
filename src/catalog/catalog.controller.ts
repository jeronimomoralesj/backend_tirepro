import {
  Controller, Get, Post, Put, Delete, Query, Body, Param,
  UseGuards, UseInterceptors, UploadedFile, Req, ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CatalogService } from './catalog.service';
import { EjeType, CompanyPlan } from '@prisma/client';
import { AdminPasswordGuard } from '../auth/guards/admin-password.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../companies/s3.service';

@Controller('catalog')
export class CatalogController {
  constructor(
    private readonly catalogService: CatalogService,
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
  ) {}

  /**
   * Resolve the caller's company + assert they're on the distribuidor plan.
   * The datasheet module is a sales-collateral tool; only distributors need
   * it, and keeping the gate here avoids leaking per-dist images to other
   * plans if somebody ever guesses the route.
   */
  private async requireDistributor(req: { user?: { companyId?: string; sub?: string } }) {
    const companyId = req.user?.companyId;
    const userId    = req.user?.sub;
    if (!companyId || !userId) throw new ForbiddenException('Auth required');
    const company = await this.prisma.company.findUnique({
      where:  { id: companyId },
      select: { id: true, plan: true },
    });
    if (!company || company.plan !== CompanyPlan.distribuidor) {
      throw new ForbiddenException('Distribuidor plan required');
    }
    return { companyId, userId };
  }

  @Get('search')
  search(
    @Query('marca') marca?: string,
    @Query('dimension') dimension?: string,
    @Query('eje') eje?: EjeType,
    @Query('terreno') terreno?: string,
    @Query('q') query?: string,
  ) {
    return this.catalogService.search({ marca, dimension, eje, terreno, query });
  }

  @Get('match')
  findMatch(
    @Query('marca') marca: string,
    @Query('dimension') dimension: string,
    @Query('eje') eje?: EjeType,
  ) {
    return this.catalogService.findBestMatch(marca, dimension, eje);
  }

  @Get('replacements')
  replacements(
    @Query('dimension') dimension: string,
    @Query('eje') eje: EjeType,
    @Query('terreno') terreno?: string,
  ) {
    return this.catalogService.getReplacements(dimension, eje, terreno);
  }

  @Get('brands')
  brands() {
    return this.catalogService.getBrands();
  }

  @Get('dimensions')
  dimensions() {
    return this.catalogService.getDimensions();
  }

  // ─── AUTOCOMPLETE — used by tire creation forms ──────────────────────────
  // No precioCop filter: admin-created SKUs without prices still surface.

  @Get('autocomplete/brands')
  autocompleteBrands(@Query('q') q?: string, @Query('limit') limit?: string) {
    return this.catalogService.autocompleteBrands(q, limit ? Number(limit) : undefined);
  }

  @Get('autocomplete/models')
  autocompleteModels(
    @Query('marca') marca: string,
    @Query('q') q?: string,
    @Query('dimension') dimension?: string,
    @Query('limit') limit?: string,
  ) {
    return this.catalogService.autocompleteModels(
      marca,
      q,
      dimension,
      limit ? Number(limit) : undefined,
    );
  }

  @Get('autocomplete/dimensions')
  autocompleteDimensions(
    @Query('marca') marca?: string,
    @Query('modelo') modelo?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    return this.catalogService.autocompleteDimensions(marca, modelo, q, limit ? Number(limit) : undefined);
  }

  @Get('stats')
  stats() {
    return this.catalogService.getStats();
  }

  // ─── CROWDSOURCE ENDPOINTS ───────────────────────────────────────────────

  /** Get aggregated crowd stats for a marca + dimension + optional modelo */
  @Get('crowd-stats')
  crowdStats(
    @Query('marca') marca: string,
    @Query('dimension') dimension: string,
    @Query('modelo') modelo?: string,
  ) {
    return this.catalogService.getCrowdStats(marca, dimension, modelo);
  }

  /** Create or update a crowdsourced catalog entry */
  @Post('crowdsource')
  crowdsource(
    @Body()
    body: {
      marca: string;
      dimension: string;
      modelo: string;
      eje?: EjeType;
      profundidadInicial?: number;
      precioCop?: number;
    },
  ) {
    return this.catalogService.crowdsourceUpsert(body);
  }

  // ─── ADMIN ENDPOINTS (TireMasterCatalog CRUD) ────────────────────────────

  /** Paginated list for admin grid — no precioCop filter, all SKUs visible */
  @Get('admin/skus')
  @UseGuards(AdminPasswordGuard)
  adminList(
    @Query('q') query?: string,
    @Query('marca') marca?: string,
    @Query('dimension') dimension?: string,
    @Query('categoria') categoria?: string,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '50',
  ) {
    return this.catalogService.adminList({
      query,
      marca,
      dimension,
      categoria,
      page: Number(page),
      pageSize: Number(pageSize),
    });
  }

  @Get('admin/skus/:id')
  @UseGuards(AdminPasswordGuard)
  adminGet(@Param('id') id: string) {
    return this.catalogService.adminGet(id);
  }

  @Post('admin/skus')
  @UseGuards(AdminPasswordGuard)
  adminCreate(@Body() body: any) {
    const { __adminPassword, ...data } = body ?? {};
    return this.catalogService.adminCreate(data);
  }

  @Put('admin/skus/:id')
  @UseGuards(AdminPasswordGuard)
  adminUpdate(@Param('id') id: string, @Body() body: any) {
    const { __adminPassword, ...data } = body ?? {};
    return this.catalogService.adminUpdate(id, data);
  }

  @Delete('admin/skus/:id')
  @UseGuards(AdminPasswordGuard)
  adminDelete(@Param('id') id: string) {
    return this.catalogService.adminDelete(id);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DISTRIBUTOR DATASHEET MODULE
  // Paths under /catalog/dist/* are for distribuidor-plan companies only.
  // Images and download events are tenant-scoped by companyId so one
  // distributor's sales data never leaks to another.
  // ═══════════════════════════════════════════════════════════════════════════

  @Get('dist/search')
  @UseGuards(JwtAuthGuard)
  async distSearch(
    @Req() req: any,
    @Query('q')         q?: string,
    @Query('marca')     marca?: string,
    @Query('dimension') dimension?: string,
    @Query('eje')       eje?: string,
    @Query('categoria') categoria?: string,
    @Query('page')      page = '1',
    @Query('pageSize')  pageSize = '24',
  ) {
    const { companyId } = await this.requireDistributor(req);
    return this.catalogService.distSearch({
      companyId, q, marca, dimension, eje, categoria,
      page: Number(page), pageSize: Number(pageSize),
    });
  }

  @Get('dist/:id')
  @UseGuards(JwtAuthGuard)
  async distGet(@Req() req: any, @Param('id') id: string) {
    const { companyId } = await this.requireDistributor(req);
    return this.catalogService.distGet(id, companyId);
  }

  @Post('dist/:id/images')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('image'))
  async distUploadImage(
    @Req() req: any,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const { companyId } = await this.requireDistributor(req);
    if (!file) throw new BadRequestException('image file required');
    const url = await this.s3.uploadCatalogImage(file.buffer, companyId, id, file.mimetype);
    return this.catalogService.addCatalogImage({ catalogId: id, companyId, url });
  }

  @Delete('dist/images/:imageId')
  @UseGuards(JwtAuthGuard)
  async distDeleteImage(@Req() req: any, @Param('imageId') imageId: string) {
    const { companyId } = await this.requireDistributor(req);
    return this.catalogService.deleteCatalogImage(imageId, companyId);
  }

  @Post('dist/:id/track-download')
  @UseGuards(JwtAuthGuard)
  async distTrackDownload(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: {
      priceMode: 'none' | 'sin_iva' | 'con_iva';
      priceCop?: number | null;
      fieldsIncluded?: Record<string, boolean>;
    },
  ) {
    const { companyId, userId } = await this.requireDistributor(req);
    // Capture network context — useful for later abuse investigation (e.g. a
    // single user suddenly bulk-exporting every SKU).
    const ip = (req.headers?.['x-forwarded-for'] as string | undefined)
      ?.split(',')[0]?.trim()
      ?? req.ip
      ?? null;
    const userAgent = (req.headers?.['user-agent'] as string | undefined) ?? null;
    return this.catalogService.trackDownload({
      userId, companyId, catalogId: id,
      priceMode: body?.priceMode ?? 'none',
      priceCop:  body?.priceCop  ?? null,
      fieldsIncluded: body?.fieldsIncluded,
      ip, userAgent,
    });
  }

  @Get('dist/downloads/stats')
  @UseGuards(JwtAuthGuard)
  async distDownloadStats(@Req() req: any, @Query('days') days = '30') {
    const { companyId } = await this.requireDistributor(req);
    return this.catalogService.distDownloadStats(companyId, Number(days) || 30);
  }

  // ─── Admin-wide (TirePro) — across all distributors ─────────────────────────

  @Get('admin/downloads/stats')
  @UseGuards(AdminPasswordGuard)
  adminDownloadStats(@Query('days') days = '30') {
    return this.catalogService.adminDownloadStats(Number(days) || 30);
  }

  @Get('admin/images/:catalogId')
  @UseGuards(AdminPasswordGuard)
  adminListImages(@Param('catalogId') catalogId: string) {
    return this.catalogService.adminListImages(catalogId);
  }
}
