import { Controller, Get, Post, Put, Delete, Query, Body, Param, UseGuards } from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { EjeType } from '@prisma/client';
import { AdminPasswordGuard } from '../auth/guards/admin-password.guard';

@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

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
}
