import { Controller, Get, Post, Query, Body } from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { EjeType } from '@prisma/client';

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
}
