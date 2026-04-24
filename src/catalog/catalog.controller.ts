import {
  Controller, Get, Post, Put, Patch, Delete, Query, Body, Param,
  UseGuards, UseInterceptors, UploadedFile, Req, Res,
  ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CatalogService } from './catalog.service';
import { EjeType, CompanyPlan } from '@prisma/client';
import { AdminPasswordGuard } from '../auth/guards/admin-password.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../companies/s3.service';
import type { Response } from 'express';

/**
 * Return the image MIME type of a buffer based on its leading magic
 * bytes, or null if it doesn't look like one of the formats jspdf can
 * consume. Used by the asset-proxy as a last-resort when S3 hands back
 * application/octet-stream instead of the Content-Type we set on upload.
 */
function sniffImageMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  // WebP: "RIFF" + xxxx + "WEBP"
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  // GIF: "GIF87a" or "GIF89a"
  if (buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  return null;
}

@Controller('catalog')
export class CatalogController {
  constructor(
    private readonly catalogService: CatalogService,
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
  ) {}

  /**
   * Resolve the caller's company + assert they're on the distribuidor plan
   * AND carry a role allowed to read/edit the catalog. The datasheet module
   * is a sales-collateral tool; only distributors need it, and keeping the
   * gate here avoids leaking per-dist images to other plans if somebody ever
   * guesses the route.
   *
   * Allowed roles: admin (full access), catalogo (sales rep), catalogo_admin
   * (sales manager). A dist-plan viewer/technician is NOT granted catalog
   * access — the permission is opt-in per user.
   *
   * Pass `requireAdmin: true` to gate stats-style endpoints to admin /
   * catalogo_admin only.
   */
  private async requireDistributor(
    req: { user?: { companyId?: string; userId?: string; role?: string } },
    opts: { requireAdmin?: boolean; roles?: string[] } = {},
  ) {
    const companyId = req.user?.companyId;
    const userId    = req.user?.userId;
    if (!companyId || !userId) throw new ForbiddenException('Auth required');

    // Resolve role + plan from the DB rather than trusting the JWT.
    // Long-lived sessions minted before the role enum was extended can
    // carry a stale or missing role — authorizing from the live user
    // record means role changes take effect on the next request instead
    // of on the next login.
    const [user, company] = await Promise.all([
      this.prisma.user.findUnique({
        where:  { id: userId },
        select: { id: true, role: true },
      }),
      this.prisma.company.findUnique({
        where:  { id: companyId },
        select: { id: true, plan: true },
      }),
    ]);
    if (!company || company.plan !== CompanyPlan.distribuidor) {
      throw new ForbiddenException('Distribuidor plan required');
    }
    const role = user?.role;
    // Allowed roles: explicit `opts.roles` wins; then the legacy
    // `requireAdmin` flag maps to admin / catalogo_admin (stats access);
    // otherwise the default catalog-access set.
    let allowed: Set<string>;
    if (opts.roles) {
      allowed = new Set(opts.roles);
    } else if (opts.requireAdmin) {
      allowed = new Set(['admin', 'catalogo_admin']);
    } else {
      allowed = new Set(['admin', 'catalogo', 'catalogo_admin']);
    }
    if (!role || !allowed.has(role)) {
      throw new ForbiddenException(
        `Rol no autorizado. Se requiere: ${[...allowed].join(' | ')}`,
      );
    }
    return { companyId, userId, role };
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

  /**
   * Discovery feed — searches the full master catalog (not just
   * subscriptions) so dist admins can curate what lands in their
   * catalog list. Each row comes back with a `subscribed: boolean`
   * flag so the UI can render "Agregar" vs "Ya en tu catálogo".
   */
  @Get('dist/discover')
  @UseGuards(JwtAuthGuard)
  async distDiscover(
    @Req() req: any,
    @Query('q')         q?: string,
    @Query('marca')     marca?: string,
    @Query('dimension') dimension?: string,
    @Query('eje')       eje?: string,
    @Query('categoria') categoria?: string,
    @Query('page')      page = '1',
    @Query('pageSize')  pageSize = '24',
  ) {
    const { companyId } = await this.requireDistributor(req, {
      roles: ['admin', 'catalogo_admin'],
    });
    return this.catalogService.distDiscover({
      companyId, q, marca, dimension, eje, categoria,
      page: Number(page), pageSize: Number(pageSize),
    });
  }

  /** Add an SKU to the dist's catalog. Open to admin + catalogo_admin:
   *  sales managers curate their list too, not just company admins.
   *  Plain catalogo (sales rep) can't. */
  @Post('dist/:id/subscribe')
  @UseGuards(JwtAuthGuard)
  async distSubscribe(@Req() req: any, @Param('id') id: string) {
    const { companyId, userId } = await this.requireDistributor(req, {
      roles: ['admin', 'catalogo_admin'],
    });
    return this.catalogService.subscribe(id, companyId, userId);
  }

  /** Remove an SKU from the dist's catalog. Images / videos / download
   *  history are preserved; they resurface if the dist re-subscribes. */
  @Delete('dist/:id/subscribe')
  @UseGuards(JwtAuthGuard)
  async distUnsubscribe(@Req() req: any, @Param('id') id: string) {
    const { companyId } = await this.requireDistributor(req, {
      roles: ['admin', 'catalogo_admin'],
    });
    return this.catalogService.unsubscribe(id, companyId);
  }

  /**
   * Sales advisor — find the best options from this dist's own catalog
   * for a prospect's profile. Accessible to every catalog-role user
   * (admins, sales managers, sales reps) since it's a selling tool.
   */
  @Post('dist/recommend')
  @UseGuards(JwtAuthGuard)
  async distRecommend(
    @Req() req: any,
    @Body() body: {
      dimension?: string;
      eje?: string;
      reencauchable?: boolean;
      tier?: 'premium' | 'mid' | 'value';
      pctPavimento?: number;
      terreno?: string;
      categoria?: 'nueva' | 'reencauche';
      indiceCarga?: string;
      indiceVelocidad?: string;
      minRtdMm?: number;
      minPsiRecomendado?: number;
      cinturones?: string;
      pr?: string;
      construccion?: string;
      segmento?: string;
      tipo?: string;
      tipoBanda?: string;
    } = {},
  ) {
    const { companyId } = await this.requireDistributor(req);
    return this.catalogService.distRecommend({
      companyId,
      dimension:         body.dimension,
      eje:               body.eje,
      reencauchable:     body.reencauchable,
      tier:              body.tier,
      pctPavimento:      typeof body.pctPavimento === 'number' ? body.pctPavimento : undefined,
      terreno:           body.terreno,
      categoria:         body.categoria,
      indiceCarga:       body.indiceCarga,
      indiceVelocidad:   body.indiceVelocidad,
      minRtdMm:          typeof body.minRtdMm === 'number' ? body.minRtdMm : undefined,
      minPsiRecomendado: typeof body.minPsiRecomendado === 'number' ? body.minPsiRecomendado : undefined,
      cinturones:        body.cinturones,
      pr:                body.pr,
      construccion:      body.construccion,
      segmento:          body.segmento,
      tipo:              body.tipo,
      tipoBanda:         body.tipoBanda,
    });
  }

  // ─── Asset proxy ──────────────────────────────────────────────────────────
  // Streams an S3 object back to the caller. Exists so the frontend PDF
  // generator can embed catalog images without relying on the bucket's
  // CORS config — every fetch() goes through our auth-aware API origin
  // instead of direct S3. Hardened: only URLs pointing at our own bucket
  // are proxied, so this isn't a generic SSRF hole.
  //
  // MUST be declared before `dist/:id` — Nest's underlying router matches
  // in declaration order, and `dist/asset-proxy` would otherwise be eaten
  // by the :id handler with id="asset-proxy" (→ 404, PDF images fail).
  @Get('dist/asset-proxy')
  @UseGuards(JwtAuthGuard)
  async distAssetProxy(
    @Req() req: any,
    @Query('url') url: string,
    @Res() res: Response,
  ) {
    await this.requireDistributor(req);
    if (!url || !this.s3.isOwnBucketUrl(url)) {
      throw new BadRequestException('URL inválida');
    }
    // Buffered fetch — simpler than streaming through Nest's @Res, and
    // catalog images are single-digit MB. fetch() is Node's undici;
    // S3 is a happy target (unlike some ancient .NET backends).
    // Note: `Response` type in this file refers to express's Response
    // (imported at the top). Let inference give us the Fetch API Response
    // from `fetch()` — don't annotate.
    let upstream: Awaited<ReturnType<typeof fetch>>;
    try {
      upstream = await fetch(url);
    } catch (err) {
      // Log and 502 — lets the frontend fall back + gives us a trail.
      console.warn(`[asset-proxy] upstream fetch failed for ${url}:`, (err as Error).message);
      res.status(502).send('');
      return;
    }
    if (!upstream.ok) {
      console.warn(`[asset-proxy] upstream ${upstream.status} for ${url}`);
      res.status(upstream.status === 404 ? 404 : 502).send('');
      return;
    }
    const buf = Buffer.from(await upstream.arrayBuffer());

    // Resolve Content-Type:
    //   1. Upstream header (best — matches what we PUT to S3)
    //   2. Magic-number sniff from the leading bytes (covers S3 responses
    //      that come back as application/octet-stream, which would
    //      otherwise break jspdf's format detection on the frontend)
    //   3. Fall back to application/octet-stream
    let contentType = upstream.headers.get('content-type') ?? '';
    if (!contentType || contentType === 'application/octet-stream') {
      contentType = sniffImageMime(buf) ?? 'application/octet-stream';
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(buf.length));
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(buf);
  }

  @Get('dist/:id')
  @UseGuards(JwtAuthGuard)
  async distGet(@Req() req: any, @Param('id') id: string) {
    const { companyId } = await this.requireDistributor(req);
    return this.catalogService.distGet(id, companyId);
  }

  /**
   * Distributor admin edit on a master catalog row. Reuses the same
   * editable-field whitelist that the TirePro admin password path uses,
   * so we get `cinturones` / `pr` / etc. for free. Role-gated to the
   * distribuidor's own `admin` — catalogo / catalogo_admin reps can't
   * mutate shared master-catalog data.
   *
   * The caveat worth flagging: this table is global. An edit here is
   * seen by every other distributor viewing the same SKU. The
   * requireDistributor guard trusts the caller company's admin; a
   * hostile edit is auditable via updatedAt and recoverable by a
   * TirePro admin via the /admin/skus CRUD.
   */
  @Patch('dist/:id')
  @UseGuards(JwtAuthGuard)
  async distUpdate(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const { companyId } = await this.requireDistributor(req, { roles: ['admin'] });
    // Narrower whitelist than the TirePro admin path — dists can't
    // overwrite fleet-derived fields (vidas, km estimates, precioCop).
    // Also gated on subscription: you can only edit a tire you've
    // added to your catalog.
    return this.catalogService.distUpdate(id, companyId, body);
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

  // ─── Video (one per SKU per dist) ─────────────────────────────────────────

  @Post('dist/:id/video')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('video'))
  async distUploadVideo(
    @Req() req: any,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const { companyId } = await this.requireDistributor(req);
    if (!file) throw new BadRequestException('video file required');
    const url = await this.s3.uploadCatalogVideo(file.buffer, companyId, id, file.mimetype);
    return this.catalogService.setCatalogVideo({
      catalogId:    id,
      companyId,
      url,
      originalName: file.originalname ?? null,
      mimeType:     file.mimetype ?? null,
      sizeBytes:    file.size ?? null,
    });
  }

  @Delete('dist/:id/video')
  @UseGuards(JwtAuthGuard)
  async distDeleteVideo(@Req() req: any, @Param('id') id: string) {
    const { companyId } = await this.requireDistributor(req);
    return this.catalogService.deleteCatalogVideo(id, companyId);
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
    // Stats are manager-only within a distribuidor company: admin or
    // catalogo_admin. A plain catalogo sales rep shouldn't see their
    // teammates' conversion numbers.
    const { companyId } = await this.requireDistributor(req, { requireAdmin: true });
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
