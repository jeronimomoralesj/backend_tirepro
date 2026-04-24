import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { EjeType, Prisma } from '@prisma/client';
import { normalizeDimension } from '../common/normalize-dimension';

// ─── Statistical helpers ─────────────────────────────────────────────────────

function median(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function percentile(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

/** Trimmed mean — drops bottom/top 10% to resist outliers */
function trimmedMean(arr: number[], trim = 0.1): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const cut = Math.floor(s.length * trim);
  const trimmed = s.slice(cut, s.length - cut || s.length);
  return trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
}

function stddev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

/**
 * Confidence score 0–1 based on:
 *  - sample size (diminishing returns past 30)
 *  - company diversity (≥3 required for meaningful cross-company data)
 *  - coefficient of variation (lower spread = higher confidence)
 */
function crowdConfidence(sampleSize: number, companyCount: number, cv: number): number {
  const sizeFactor = Math.min(sampleSize / 30, 1);                   // 0→1
  const diversityFactor = Math.min(Math.max(companyCount - 1, 0) / 4, 1); // 0→1
  const spreadFactor = Math.max(1 - cv, 0.1);                        // lower CV = better
  return Math.round(sizeFactor * 0.4 + diversityFactor * 0.3 + spreadFactor * 0.3) * 100 / 100;
}

@Injectable()
export class CatalogService {
  private static TTL = 24 * 60 * 60 * 1000; // 24h — catalog rarely changes
  private readonly logger = new Logger(CatalogService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  /** Search the master catalog with optional filters */
  async search(filters: {
    marca?: string;
    dimension?: string;
    eje?: EjeType;
    terreno?: string;
    query?: string; // free-text search across marca + modelo
  }) {
    const where: any = {};

    if (filters.marca) {
      where.marca = { equals: filters.marca, mode: 'insensitive' };
    }
    if (filters.dimension) {
      where.dimension = { contains: filters.dimension, mode: 'insensitive' };
    }
    if (filters.eje) {
      where.ejeTirePro = filters.eje;
    }
    if (filters.terreno) {
      where.terreno = { equals: filters.terreno, mode: 'insensitive' };
    }
    if (filters.query) {
      where.OR = [
        { marca:     { contains: filters.query, mode: 'insensitive' } },
        { modelo:    { contains: filters.query, mode: 'insensitive' } },
        { dimension: { contains: filters.query, mode: 'insensitive' } },
      ];
    }

    // Prefer SKUs with real prices; exclude $0 entries
    where.precioCop = { gt: 0 };

    return this.prisma.tireMasterCatalog.findMany({
      where,
      orderBy: [
        { precioCop: 'asc' },
      ],
      take: 50,
    });
  }

  /** Look up the best catalog match for a tire by marca + dimension + eje */
  async findBestMatch(marca: string, dimension: string, eje?: EjeType) {
    const cacheKey = `catalog:match:${marca}:${dimension}:${eje ?? 'any'}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) return cached;

    const where: any = {
      marca: { equals: marca, mode: 'insensitive' },
      dimension: { contains: dimension, mode: 'insensitive' },
    };
    if (eje) where.ejeTirePro = eje;

    const match = await this.prisma.tireMasterCatalog.findFirst({
      where,
      orderBy: { precioCop: { sort: 'asc', nulls: 'last' } },
    });

    if (match) await this.cache.set(cacheKey, match, CatalogService.TTL);
    return match;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTOCOMPLETE — fast prefix/contains search for create/inspect forms.
  // Unlike /search these endpoints do NOT require precioCop > 0, so
  // admin-created SKUs without pricing still show up as typeahead options.
  // ═══════════════════════════════════════════════════════════════════════════

  // Per-group aggregation of the TireMasterCatalog. Returns each unique
  // marca/modelo/dimension combined with a "sample" SKU the UI can use to
  // auto-fill rtdMm, precioCop etc. when the user picks a suggestion.
  private async aggregateCatalog(
    groupField: 'marca' | 'modelo' | 'dimension',
    where: any,
    limit: number,
  ) {
    const rows = await this.prisma.tireMasterCatalog.findMany({
      where,
      select: {
        marca: true, modelo: true, dimension: true, skuRef: true,
        rtdMm: true, psiRecomendado: true, precioCop: true,
        kmEstimadosReales: true, terreno: true, categoria: true,
        crowdSampleSize: true,
      },
      // Prefer entries with pricing and higher crowd signal first.
      orderBy: [
        { precioCop: { sort: 'desc', nulls: 'last' } },
        { crowdSampleSize: 'desc' },
        { updatedAt: 'desc' },
      ],
      take: Math.min(limit * 6, 1000), // over-fetch so merge keeps enough groups
    });

    const merged = new Map<string, { value: string; count: number; sample: any }>();
    for (const r of rows) {
      const value = (r as any)[groupField] as string;
      if (!value) continue;
      const key = value.trim().toLowerCase();
      const existing = merged.get(key);
      if (existing) {
        existing.count += 1;
        // Upgrade sample only when current sample lacks price and new one has it.
        if (!existing.sample.precioCop && r.precioCop) existing.sample = r;
      } else {
        merged.set(key, { value: value.trim(), count: 1, sample: r });
      }
      if (merged.size >= limit) break;
    }

    return Array.from(merged.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  async autocompleteBrands(query?: string, limit = 30) {
    const where: any = {};
    if (query?.trim()) {
      where.marca = { contains: query.trim(), mode: 'insensitive' };
    }
    const agg = await this.aggregateCatalog('marca', where, Math.min(limit, 100));
    return agg.map((g) => ({
      marca: g.value,
      count: g.count,
      sample: g.sample,
    }));
  }

  async autocompleteModels(
    marca: string,
    query?: string,
    dimension?: string,
    limit = 50,
  ) {
    if (!marca?.trim()) return [];
    const where: any = { marca: { equals: marca.trim(), mode: 'insensitive' } };
    if (dimension?.trim()) {
      where.dimension = { equals: dimension.trim(), mode: 'insensitive' };
    }
    if (query?.trim()) {
      where.modelo = { contains: query.trim(), mode: 'insensitive' };
    }
    const agg = await this.aggregateCatalog('modelo', where, Math.min(limit, 200));
    return agg.map((g) => ({
      modelo: g.value,
      count: g.count,
      sample: g.sample,
    }));
  }

  async autocompleteDimensions(
    marca?: string,
    modelo?: string,
    query?: string,
    limit = 60,
  ) {
    const where: any = {};
    if (marca?.trim())  where.marca  = { equals: marca.trim(),  mode: 'insensitive' };
    if (modelo?.trim()) where.modelo = { equals: modelo.trim(), mode: 'insensitive' };
    if (query?.trim()) {
      where.dimension = { contains: query.trim(), mode: 'insensitive' };
    }
    const agg = await this.aggregateCatalog('dimension', where, Math.min(limit, 200));
    return agg.map((g) => ({
      dimension: g.value,
      count: g.count,
      sample: g.sample,
    }));
  }

  /** Get all unique brands in the catalog (only those with real prices) */
  async getBrands() {
    const cacheKey = 'catalog:brands';
    const cached = await this.cache.get(cacheKey);
    if (cached) return cached;

    const brands = await this.prisma.tireMasterCatalog.findMany({
      where: { precioCop: { gt: 0 } },
      select: { marca: true },
      distinct: ['marca'],
      orderBy: { marca: 'asc' },
    });

    const result = brands.map((b) => b.marca);
    await this.cache.set(cacheKey, result, CatalogService.TTL);
    return result;
  }

  /** Get all unique dimensions in the catalog (only those with real prices) */
  async getDimensions() {
    const cacheKey = 'catalog:dimensions';
    const cached = await this.cache.get(cacheKey);
    if (cached) return cached;

    const dims = await this.prisma.tireMasterCatalog.findMany({
      where: { precioCop: { gt: 0 } },
      select: { dimension: true },
      distinct: ['dimension'],
      orderBy: { dimension: 'asc' },
    });

    const result = dims.map((d) => d.dimension);
    await this.cache.set(cacheKey, result, CatalogService.TTL);
    return result;
  }

  /** Get replacement suggestions for a tire that needs to be replaced */
  async getReplacements(dimension: string, eje: EjeType, terreno?: string) {
    const where: any = {
      dimension: { contains: dimension, mode: 'insensitive' },
      ejeTirePro: eje,
    };
    if (terreno) {
      where.terreno = { equals: terreno, mode: 'insensitive' };
    }

    return this.prisma.tireMasterCatalog.findMany({
      where,
      orderBy: { precioCop: { sort: 'asc', nulls: 'last' } },
      take: 10,
    });
  }

  /** Stats overview */
  async getStats() {
    const [total, brands, dimensions] = await Promise.all([
      this.prisma.tireMasterCatalog.count(),
      this.prisma.tireMasterCatalog.findMany({ select: { marca: true }, distinct: ['marca'] }),
      this.prisma.tireMasterCatalog.findMany({ select: { dimension: true }, distinct: ['dimension'] }),
    ]);
    return { totalSkus: total, totalBrands: brands.length, totalDimensions: dimensions.length };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CROWDSOURCE INTELLIGENCE ENGINE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Aggregate real-world stats from all tires matching marca + dimension + modelo.
   * Returns raw statistics even if no catalog entry exists yet.
   */
  async getCrowdStats(marca: string, dimension: string, modelo?: string) {
    const where: any = {
      marca: { equals: marca, mode: 'insensitive' },
      dimension: { equals: dimension, mode: 'insensitive' },
    };
    if (modelo) {
      where.diseno = { equals: modelo, mode: 'insensitive' };
    }

    const tires = await this.prisma.tire.findMany({
      where,
      select: {
        id: true,
        companyId: true,
        profundidadInicial: true,
        kilometrosRecorridos: true,
        currentCpk: true,
        currentProfundidad: true,
        costos: {
          where: { concepto: 'compra_nueva' },
          select: { valor: true },
          take: 1,
        },
        inspecciones: {
          orderBy: { fecha: 'desc' },
          take: 2,
          select: {
            profundidadInt: true,
            profundidadCen: true,
            profundidadExt: true,
            kilometrosEstimados: true,
            cpk: true,
          },
        },
      },
    });

    if (!tires.length) {
      return { sampleSize: 0, companyCount: 0, confidence: 0 };
    }

    const companies = new Set(tires.map((t) => t.companyId));
    const prices = tires
      .map((t) => t.costos[0]?.valor)
      .filter((v): v is number => v != null && v > 0);
    const depths = tires
      .map((t) => t.profundidadInicial)
      .filter((v): v is number => v != null && v > 0);
    const kms = tires
      .map((t) => t.kilometrosRecorridos)
      .filter((v): v is number => v != null && v > 0);
    const cpks = tires
      .map((t) => t.currentCpk)
      .filter((v): v is number => v != null && v > 0);

    // Wear rate: (initialDepth - currentDepth) / (km / 1000)
    const wearRates = tires
      .filter((t) => t.profundidadInicial && t.currentProfundidad && t.kilometrosRecorridos > 5000)
      .map((t) => {
        const worn = t.profundidadInicial - (t.currentProfundidad ?? t.profundidadInicial);
        return worn > 0 ? worn / (t.kilometrosRecorridos / 1000) : null;
      })
      .filter((v): v is number => v != null && v > 0);

    const priceCV = prices.length >= 2 ? stddev(prices) / trimmedMean(prices) : 1;
    const conf = crowdConfidence(tires.length, companies.size, priceCV);

    return {
      sampleSize: tires.length,
      companyCount: companies.size,
      confidence: Math.round(conf * 100) / 100,
      price: prices.length
        ? {
            avg: Math.round(trimmedMean(prices)),
            median: Math.round(median(prices)),
            stddev: Math.round(stddev(prices)),
            p25: Math.round(percentile(prices, 25)),
            p75: Math.round(percentile(prices, 75)),
            n: prices.length,
          }
        : null,
      initialDepth: depths.length
        ? {
            avg: Math.round(trimmedMean(depths) * 10) / 10,
            median: Math.round(median(depths) * 10) / 10,
            stddev: Math.round(stddev(depths) * 10) / 10,
            n: depths.length,
          }
        : null,
      km: kms.length
        ? {
            avg: Math.round(trimmedMean(kms)),
            median: Math.round(median(kms)),
            n: kms.length,
          }
        : null,
      cpk: cpks.length
        ? {
            avg: Math.round(trimmedMean(cpks) * 100) / 100,
            median: Math.round(median(cpks) * 100) / 100,
            n: cpks.length,
          }
        : null,
      wearRate: wearRates.length
        ? {
            avg: Math.round(trimmedMean(wearRates) * 1000) / 1000,
            median: Math.round(median(wearRates) * 1000) / 1000,
            n: wearRates.length,
          }
        : null,
    };
  }

  /**
   * Create or update a crowdsourced catalog entry.
   * Called when a user submits a tire with marca/dimension/modelo not in catalog,
   * or periodically to refresh crowd stats on existing entries.
   */
  async crowdsourceUpsert(input: {
    marca: string;
    dimension: string;
    modelo: string;
    eje?: EjeType;
    profundidadInicial?: number;
    precioCop?: number;
  }) {
    const marca = input.marca.trim().toLowerCase();
    const modelo = input.modelo.trim().toLowerCase();
    const dimension = normalizeDimension(input.dimension);

    // Check if a catalog entry already exists for this combo
    const existing = await this.prisma.tireMasterCatalog.findFirst({
      where: {
        marca: { equals: marca, mode: 'insensitive' },
        modelo: { equals: modelo, mode: 'insensitive' },
        dimension: { equals: dimension, mode: 'insensitive' },
      },
    });

    // Aggregate crowd stats from all tires
    const stats = await this.getCrowdStats(marca, dimension, modelo);

    const crowdFields = {
      crowdSampleSize: stats.sampleSize,
      crowdCompanyCount: stats.companyCount,
      crowdConfidence: stats.confidence,
      crowdAvgPrice: stats.price?.avg ?? null,
      crowdMedianPrice: stats.price?.median ?? null,
      crowdStddevPrice: stats.price?.stddev ?? null,
      crowdP25Price: stats.price?.p25 ?? null,
      crowdP75Price: stats.price?.p75 ?? null,
      crowdAvgInitialDepth: stats.initialDepth?.avg ?? null,
      crowdMedianInitialDepth: stats.initialDepth?.median ?? null,
      crowdStddevDepth: stats.initialDepth?.stddev ?? null,
      crowdAvgKm: stats.km?.avg ?? null,
      crowdMedianKm: stats.km?.median ?? null,
      crowdAvgCpk: stats.cpk?.avg ?? null,
      crowdMedianCpk: stats.cpk?.median ?? null,
      crowdAvgWearRate: stats.wearRate?.avg ?? null,
      crowdLastUpdated: new Date(),
    };

    if (existing) {
      // Update existing entry with fresh crowd data
      const updated = await this.prisma.tireMasterCatalog.update({
        where: { id: existing.id },
        data: {
          ...crowdFields,
          // Update price/depth from crowd data if no manufacturer data exists
          ...(existing.precioCop == null && stats.price
            ? { precioCop: stats.price.median }
            : {}),
          ...(existing.rtdMm == null && stats.initialDepth
            ? { rtdMm: stats.initialDepth.median }
            : {}),
          ...(existing.kmEstimadosReales == null && stats.km
            ? { kmEstimadosReales: stats.km.median }
            : {}),
          // Recompute cpkEstimado if we now have both price and km
          ...(() => {
            const price = existing.precioCop ?? stats.price?.median;
            const km = existing.kmEstimadosReales ?? stats.km?.median;
            return price && km ? { cpkEstimado: Math.round((price / km) * 100) / 100 } : {};
          })(),
        },
      });
      this.logger.log(`Crowdsource updated SKU ${existing.skuRef} — ${stats.sampleSize} samples`);
      return { action: 'updated', catalog: updated, stats };
    }

    // Create new crowdsourced catalog entry
    const skuRef = `CROWD-${marca.toUpperCase().replace(/\s+/g, '')}-${modelo.toUpperCase().replace(/\s+/g, '')}-${dimension.replace(/[^a-zA-Z0-9]/g, '')}`.slice(0, 64);

    // Check skuRef uniqueness
    const skuExists = await this.prisma.tireMasterCatalog.findUnique({ where: { skuRef } });
    const finalSku = skuExists ? `${skuRef}-${Date.now().toString(36)}` : skuRef;

    const created = await this.prisma.tireMasterCatalog.create({
      data: {
        marca,
        modelo,
        dimension,
        skuRef: finalSku,
        fuente: 'crowdsource',
        ejeTirePro: input.eje ?? null,
        rtdMm: stats.initialDepth?.median ?? input.profundidadInicial ?? null,
        precioCop: stats.price?.median ?? input.precioCop ?? null,
        kmEstimadosReales: stats.km?.median ?? null,
        cpkEstimado: (() => {
          const price = stats.price?.median ?? input.precioCop;
          const km = stats.km?.median;
          return price && km ? Math.round((price / km) * 100) / 100 : null;
        })(),
        ...crowdFields,
      },
    });

    // Invalidate brand/dimension caches so new entries appear immediately
    await Promise.all([
      this.cache.del('catalog:brands'),
      this.cache.del('catalog:dimensions'),
    ]);

    this.logger.log(`Crowdsource created SKU ${finalSku} — ${stats.sampleSize} samples, confidence ${stats.confidence}`);
    return { action: 'created', catalog: created, stats };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ADMIN CRUD
  // ═══════════════════════════════════════════════════════════════════════════

  // Everything a TirePro admin can edit on a master SKU row. Crowd*
  // fields are deliberately excluded — they're computed by
  // crowdsourceUpsert and letting a human edit them would corrupt the
  // aggregation.
  private readonly adminEditableFields = [
    'marca', 'modelo', 'dimension', 'skuRef',
    'anchoMm', 'perfil', 'rin',
    'posicion', 'ejeTirePro', 'terreno', 'pctPavimento', 'pctDestapado',
    'rtdMm', 'indiceCarga', 'indiceVelocidad', 'psiRecomendado', 'pesoKg',
    'cinturones', 'pr',
    'kmEstimadosReales', 'kmEstimadosFabrica',
    'reencauchable', 'vidasReencauche', 'tipoBanda',
    'precioCop', 'cpkEstimado',
    'categoria', 'segmento', 'tipo', 'construccion',
    'notasColombia', 'fuente', 'url',
  ];

  // Narrower whitelist for distribuidor admins editing via /dist/:id.
  // Deliberately omits the fields TirePro derives from fleet averages:
  //   - vidasReencauche + kmEstimadosReales/Fabrica  (fleet averages)
  //   - precioCop / cpkEstimado                      (our pricing column)
  // so a distribuidor can't overwrite them with a local-opinion number.
  private readonly distEditableFields = [
    'marca', 'modelo', 'dimension', 'skuRef',
    'anchoMm', 'perfil', 'rin',
    'posicion', 'ejeTirePro', 'terreno', 'pctPavimento', 'pctDestapado',
    'rtdMm', 'indiceCarga', 'indiceVelocidad', 'psiRecomendado', 'pesoKg',
    'cinturones', 'pr',
    'reencauchable', 'tipoBanda',
    'categoria', 'segmento', 'tipo', 'construccion',
    'notasColombia', 'fuente', 'url',
  ];

  private pickEditable(data: Record<string, any>, whitelist: readonly string[] = this.adminEditableFields) {
    const out: Record<string, any> = {};
    for (const k of whitelist) {
      if (k in data) out[k] = data[k] === '' ? null : data[k];
    }
    return out;
  }

  /** Distribuidor-admin edit. Re-uses adminUpdate's Prisma + error path
   *  but filters incoming keys against distEditableFields so fleet-
   *  derived fields (vidas, km, precioCop) can't be overwritten. */
  async distUpdate(id: string, data: Record<string, any>) {
    const payload = this.pickEditable(data, this.distEditableFields);
    if (payload.dimension) payload.dimension = normalizeDimension(payload.dimension);
    try {
      const updated = await this.prisma.tireMasterCatalog.update({
        where: { id },
        data:  payload,
      });
      await Promise.all([this.cache.del('catalog:brands'), this.cache.del('catalog:dimensions')]);
      return updated;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException('SKU not found');
      }
      throw e;
    }
  }

  async adminList(params: { query?: string; marca?: string; dimension?: string; categoria?: string; page: number; pageSize: number }) {
    const where: any = {};
    if (params.marca) where.marca = { equals: params.marca, mode: 'insensitive' };
    if (params.dimension) where.dimension = { contains: params.dimension, mode: 'insensitive' };
    if (params.categoria) where.categoria = { equals: params.categoria, mode: 'insensitive' };
    if (params.query) {
      where.OR = [
        { marca: { contains: params.query, mode: 'insensitive' } },
        { modelo: { contains: params.query, mode: 'insensitive' } },
        { dimension: { contains: params.query, mode: 'insensitive' } },
        { skuRef: { contains: params.query, mode: 'insensitive' } },
      ];
    }
    const page = Math.max(1, params.page);
    const pageSize = Math.min(200, Math.max(1, params.pageSize));
    const [total, items] = await Promise.all([
      this.prisma.tireMasterCatalog.count({ where }),
      this.prisma.tireMasterCatalog.findMany({
        where,
        orderBy: [{ marca: 'asc' }, { modelo: 'asc' }, { dimension: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { total, page, pageSize, items };
  }

  async adminGet(id: string) {
    const sku = await this.prisma.tireMasterCatalog.findUnique({ where: { id } });
    if (!sku) throw new NotFoundException('SKU not found');
    return sku;
  }

  async adminCreate(data: Record<string, any>) {
    const payload = this.pickEditable(data);
    if (!payload.marca || !payload.modelo || !payload.dimension || !payload.skuRef) {
      throw new BadRequestException('marca, modelo, dimension and skuRef are required');
    }
    payload.dimension = normalizeDimension(payload.dimension);

    const skuRef = String(payload.skuRef).trim();
    const existing = await this.prisma.tireMasterCatalog.findUnique({
      where: { skuRef },
      select: { id: true, marca: true, modelo: true, dimension: true },
    });
    if (existing) {
      throw new ConflictException({
        message: `skuRef "${skuRef}" already exists`,
        code: 'SKU_REF_TAKEN',
        existing,
      });
    }

    try {
      const created = await this.prisma.tireMasterCatalog.create({
        data: { ...payload, skuRef, fuente: payload.fuente ?? 'admin' },
      });
      await Promise.all([this.cache.del('catalog:brands'), this.cache.del('catalog:dimensions')]);
      return created;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException({
          message: `skuRef "${skuRef}" already exists`,
          code: 'SKU_REF_TAKEN',
        });
      }
      throw e;
    }
  }

  async adminUpdate(id: string, data: Record<string, any>) {
    const payload = this.pickEditable(data);
    if (payload.dimension) payload.dimension = normalizeDimension(payload.dimension);

    if (payload.skuRef) {
      const skuRef = String(payload.skuRef).trim();
      payload.skuRef = skuRef;
      const clash = await this.prisma.tireMasterCatalog.findUnique({
        where: { skuRef },
        select: { id: true },
      });
      if (clash && clash.id !== id) {
        throw new ConflictException({
          message: `skuRef "${skuRef}" already belongs to another SKU`,
          code: 'SKU_REF_TAKEN',
          existingId: clash.id,
        });
      }
    }

    try {
      const updated = await this.prisma.tireMasterCatalog.update({
        where: { id },
        data: payload,
      });
      await Promise.all([this.cache.del('catalog:brands'), this.cache.del('catalog:dimensions')]);
      return updated;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError) {
        if (e.code === 'P2002') {
          throw new ConflictException({
            message: 'skuRef collision',
            code: 'SKU_REF_TAKEN',
          });
        }
        if (e.code === 'P2025') {
          throw new NotFoundException('SKU not found');
        }
      }
      throw e;
    }
  }

  async adminDelete(id: string) {
    await this.prisma.tireMasterCatalog.delete({ where: { id } });
    await Promise.all([this.cache.del('catalog:brands'), this.cache.del('catalog:dimensions')]);
    return { ok: true };
  }

  /**
   * Called after every tire creation + inspection to keep crowd stats fresh.
   * Lightweight — skips if updated within the last hour.
   */
  async enrichFromTireData(marca: string, dimension: string, modelo: string) {
    const existing = await this.prisma.tireMasterCatalog.findFirst({
      where: {
        marca: { equals: marca, mode: 'insensitive' },
        modelo: { equals: modelo, mode: 'insensitive' },
        dimension: { equals: dimension, mode: 'insensitive' },
      },
      select: { id: true, crowdLastUpdated: true },
    });

    // Throttle: skip if updated within last hour
    if (existing?.crowdLastUpdated) {
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
      if (existing.crowdLastUpdated > hourAgo) return;
    }

    return this.crowdsourceUpsert({ marca, dimension, modelo });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DISTRIBUTOR SKU CATALOG — read API that distributors use to search the
  // master catalog, pull per-SKU detail with their own uploaded images, and
  // log downloads. Each distributor sees ONLY their own uploaded images so
  // sales collateral doesn't mix between accounts. Admin (TirePro) reads
  // all images via `getAllCatalogImages`.
  // ═══════════════════════════════════════════════════════════════════════════

  /** Fuzzy search across marca/modelo/dimension with eje/terreno/categoria filters. */
  async distSearch(params: {
    companyId: string;
    q?: string;
    marca?: string;
    dimension?: string;
    eje?: string;
    categoria?: string; // "nueva" | "reencauche"
    page?: number;
    pageSize?: number;
  }) {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 24));
    const where: Prisma.TireMasterCatalogWhereInput = {};

    if (params.marca)     where.marca     = { equals: params.marca, mode: 'insensitive' };
    if (params.dimension) where.dimension = { contains: params.dimension, mode: 'insensitive' };
    if (params.eje)       where.ejeTirePro = params.eje as EjeType;
    if (params.categoria) where.categoria = { equals: params.categoria, mode: 'insensitive' };
    // Token-aware + typo-tolerant search. A query like "continental hdr
    // 295" used to fail because `contains: "continental hdr 295"` never
    // matches any single field — marca is "Continental", modelo is
    // "HDR2", dimension is "295/80R22.5". Splitting on whitespace and
    // requiring each token to hit SOME field via AND-of-ORs gives
    // natural "narrow as you type" behavior.
    //
    // On top of that, each alphabetic token is fuzzy-expanded against
    // the distinct set of marcas + modelos in the catalog — so
    // "hanckook" picks up the real "hankook" via Levenshtein distance.
    if (params.q) {
      const tokens = params.q.trim().split(/\s+/).filter(Boolean);
      if (tokens.length > 0) {
        const variants = await Promise.all(tokens.map((t) => this.expandTokenFuzzy(t)));
        where.AND = variants.map((alts) => ({
          OR: alts.flatMap((v) => [
            { marca:     { contains: v, mode: 'insensitive' as const } },
            { modelo:    { contains: v, mode: 'insensitive' as const } },
            { dimension: { contains: v, mode: 'insensitive' as const } },
            { skuRef:    { contains: v, mode: 'insensitive' as const } },
          ]),
        }));
      }
    }

    const [total, items] = await Promise.all([
      this.prisma.tireMasterCatalog.count({ where }),
      this.prisma.tireMasterCatalog.findMany({
        where,
        orderBy: [{ marca: 'asc' }, { modelo: 'asc' }, { dimension: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        // One image per catalog row is enough for a listing thumbnail — the
        // detail endpoint returns the full gallery.
        include: {
          images: {
            where: { companyId: params.companyId },
            orderBy: { coverIndex: 'asc' },
            take: 1,
          },
        },
      }),
    ]);

    return { total, page, pageSize, items };
  }

  /** Full SKU detail including every image + the single video this
   *  distributor has uploaded (videos are 1-per-SKU by unique constraint). */
  async distGet(catalogId: string, companyId: string) {
    const sku = await this.prisma.tireMasterCatalog.findUnique({
      where: { id: catalogId },
      include: {
        images: {
          where: { companyId },
          orderBy: { coverIndex: 'asc' },
        },
        videos: {
          where: { companyId },
          take: 1,
        },
      },
    });
    if (!sku) throw new NotFoundException('SKU not found');
    // Flatten the video array into a single field — the UI cares about
    // 1-or-0, and returning an array invites confusion later if we ever
    // relax the uniqueness.
    const { videos, ...rest } = sku as typeof sku & { videos: Array<Record<string, unknown>> };
    return { ...rest, video: videos?.[0] ?? null };
  }

  /** Replace (or create) the single video for this (dist, SKU) pair. If
   *  one already exists we keep the row and overwrite its URL — simpler
   *  than delete-then-create and avoids FK cascades. */
  async setCatalogVideo(params: {
    catalogId: string;
    companyId: string;
    url: string;
    originalName?: string | null;
    mimeType?: string | null;
    sizeBytes?: number | null;
  }) {
    const sku = await this.prisma.tireMasterCatalog.findUnique({
      where:  { id: params.catalogId },
      select: { id: true },
    });
    if (!sku) throw new NotFoundException('SKU not found');

    return this.prisma.catalogVideo.upsert({
      where: { catalogId_companyId: { catalogId: params.catalogId, companyId: params.companyId } },
      create: {
        catalogId:    params.catalogId,
        companyId:    params.companyId,
        url:          params.url,
        originalName: params.originalName ?? null,
        mimeType:     params.mimeType ?? null,
        sizeBytes:    params.sizeBytes ?? null,
      },
      update: {
        url:          params.url,
        originalName: params.originalName ?? null,
        mimeType:     params.mimeType ?? null,
        sizeBytes:    params.sizeBytes ?? null,
      },
    });
  }

  async deleteCatalogVideo(catalogId: string, companyId: string) {
    const existing = await this.prisma.catalogVideo.findUnique({
      where: { catalogId_companyId: { catalogId, companyId } },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Video no encontrado');
    await this.prisma.catalogVideo.delete({ where: { id: existing.id } });
    return { ok: true };
  }

  /** Persist a new image row after the S3 upload already succeeded. */
  async addCatalogImage(params: {
    catalogId: string;
    companyId: string;
    url: string;
  }) {
    const sku = await this.prisma.tireMasterCatalog.findUnique({
      where: { id: params.catalogId },
      select: { id: true },
    });
    if (!sku) throw new NotFoundException('SKU not found');

    // New image lands at the end of the gallery.
    const last = await this.prisma.catalogImage.findFirst({
      where: { catalogId: params.catalogId, companyId: params.companyId },
      orderBy: { coverIndex: 'desc' },
      select: { coverIndex: true },
    });
    const coverIndex = (last?.coverIndex ?? -1) + 1;

    return this.prisma.catalogImage.create({
      data: {
        catalogId:  params.catalogId,
        companyId:  params.companyId,
        url:        params.url,
        coverIndex,
      },
    });
  }

  /** Delete one of this distributor's images. Tenant-scoped — can't delete
   *  an image that belongs to another company. */
  async deleteCatalogImage(imageId: string, companyId: string) {
    const img = await this.prisma.catalogImage.findUnique({
      where: { id: imageId },
      select: { id: true, companyId: true },
    });
    if (!img) throw new NotFoundException('Image not found');
    if (img.companyId !== companyId) throw new BadRequestException('Not your image');
    await this.prisma.catalogImage.delete({ where: { id: imageId } });
    return { ok: true };
  }

  /** Log a PDF download. Called by the frontend after the file save succeeds. */
  async trackDownload(params: {
    userId: string;
    companyId: string;
    catalogId: string;
    priceMode: 'none' | 'sin_iva' | 'con_iva';
    priceCop?: number | null;
    fieldsIncluded?: Record<string, boolean>;
    ip?: string | null;
    userAgent?: string | null;
  }) {
    // Thin validation — a bad priceMode from the frontend should surface.
    if (!['none', 'sin_iva', 'con_iva'].includes(params.priceMode)) {
      throw new BadRequestException('Invalid priceMode');
    }
    return this.prisma.catalogDownload.create({
      data: {
        userId:         params.userId,
        companyId:      params.companyId,
        catalogId:      params.catalogId,
        priceMode:      params.priceMode as any,
        priceCop:       params.priceCop ?? null,
        fieldsIncluded: (params.fieldsIncluded ?? null) as any,
        ip:             params.ip ?? null,
        userAgent:      params.userAgent ?? null,
      },
      select: { id: true, createdAt: true },
    });
  }

  /**
   * Sales-manager dashboard data: totals by user and by SKU plus a 30-day
   * daily series. Scoped to one distributor — TirePro admin uses the
   * global variant below.
   */
  async distDownloadStats(companyId: string, days = 30) {
    const since = new Date(Date.now() - days * 86_400_000);

    const [totalAll, totalRange, byUser, bySku, daily] = await Promise.all([
      this.prisma.catalogDownload.count({ where: { companyId } }),
      this.prisma.catalogDownload.count({ where: { companyId, createdAt: { gte: since } } }),
      this.prisma.catalogDownload.groupBy({
        by: ['userId'],
        where: { companyId, createdAt: { gte: since } },
        _count: { userId: true },
        orderBy: { _count: { userId: 'desc' } },
        take: 50,
      }),
      this.prisma.catalogDownload.groupBy({
        by: ['catalogId'],
        where: { companyId, createdAt: { gte: since } },
        _count: { catalogId: true },
        orderBy: { _count: { catalogId: 'desc' } },
        take: 50,
      }),
      this.prisma.$queryRaw<Array<{ day: Date; n: bigint }>>`
        SELECT date_trunc('day', "createdAt")::date AS day,
               COUNT(*)::bigint AS n
          FROM catalog_downloads
         WHERE "companyId" = ${companyId} AND "createdAt" >= ${since}
         GROUP BY day
         ORDER BY day ASC
      `,
    ]);

    // Hydrate users + SKUs so the frontend can render names without
    // round-tripping for each bucket.
    const [users, skus] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: byUser.map((b) => b.userId) } },
        select: { id: true, name: true, email: true },
      }),
      this.prisma.tireMasterCatalog.findMany({
        where: { id: { in: bySku.map((b) => b.catalogId) } },
        select: { id: true, marca: true, modelo: true, dimension: true, skuRef: true },
      }),
    ]);
    const userById = new Map(users.map((u) => [u.id, u]));
    const skuById  = new Map(skus.map((s) => [s.id, s]));

    return {
      totals: { allTime: totalAll, range: totalRange, days },
      byUser: byUser.map((b) => ({
        user: userById.get(b.userId) ?? { id: b.userId, name: 'desconocido', email: null },
        count: b._count.userId,
      })),
      bySku: bySku.map((b) => ({
        sku: skuById.get(b.catalogId) ?? { id: b.catalogId, marca: '?', modelo: '?', dimension: '?', skuRef: '?' },
        count: b._count.catalogId,
      })),
      daily: daily.map((d) => ({ day: d.day, count: Number(d.n) })),
    };
  }

  /** TirePro admin — same stats but across every distributor, with a
   *  per-company breakdown. Used on the /blog/admin catalog-downloads tab. */
  async adminDownloadStats(days = 30) {
    const since = new Date(Date.now() - days * 86_400_000);
    const [totalAll, byCompany, bySku, daily] = await Promise.all([
      this.prisma.catalogDownload.count(),
      this.prisma.catalogDownload.groupBy({
        by: ['companyId'],
        where: { createdAt: { gte: since } },
        _count: { companyId: true },
        orderBy: { _count: { companyId: 'desc' } },
        take: 100,
      }),
      this.prisma.catalogDownload.groupBy({
        by: ['catalogId'],
        where: { createdAt: { gte: since } },
        _count: { catalogId: true },
        orderBy: { _count: { catalogId: 'desc' } },
        take: 50,
      }),
      this.prisma.$queryRaw<Array<{ day: Date; n: bigint }>>`
        SELECT date_trunc('day', "createdAt")::date AS day,
               COUNT(*)::bigint AS n
          FROM catalog_downloads
         WHERE "createdAt" >= ${since}
         GROUP BY day
         ORDER BY day ASC
      `,
    ]);

    const [companies, skus] = await Promise.all([
      this.prisma.company.findMany({
        where: { id: { in: byCompany.map((b) => b.companyId) } },
        select: { id: true, name: true, plan: true },
      }),
      this.prisma.tireMasterCatalog.findMany({
        where: { id: { in: bySku.map((b) => b.catalogId) } },
        select: { id: true, marca: true, modelo: true, dimension: true, skuRef: true },
      }),
    ]);
    const companyById = new Map(companies.map((c) => [c.id, c]));
    const skuById     = new Map(skus.map((s) => [s.id, s]));

    return {
      totals: { allTime: totalAll, days },
      byCompany: byCompany.map((b) => ({
        company: companyById.get(b.companyId) ?? { id: b.companyId, name: '?', plan: null },
        count: b._count.companyId,
      })),
      bySku: bySku.map((b) => ({
        sku: skuById.get(b.catalogId) ?? { id: b.catalogId, marca: '?', modelo: '?', dimension: '?', skuRef: '?' },
        count: b._count.catalogId,
      })),
      daily: daily.map((d) => ({ day: d.day, count: Number(d.n) })),
    };
  }

  /** TirePro admin reads — every catalog image across every distributor. */
  async adminListImages(catalogId: string) {
    return this.prisma.catalogImage.findMany({
      where: { catalogId },
      orderBy: [{ companyId: 'asc' }, { coverIndex: 'asc' }],
      include: { company: { select: { id: true, name: true, plan: true } } },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Fuzzy search — typo tolerance for distSearch
  // Caches every distinct marca + modelo from the master catalog and
  // lets the distSearch token matcher include near-misses via
  // Levenshtein distance. Cheap in memory (low-thousands of strings)
  // and fast to compute against per-query (few hundred Levenshtein
  // comparisons, each early-terminated at distance > maxDist).
  // ═══════════════════════════════════════════════════════════════════════════

  private fuzzyTermsCache: { terms: string[]; expiresAt: number } | null = null;

  private async getFuzzyTerms(): Promise<string[]> {
    if (this.fuzzyTermsCache && this.fuzzyTermsCache.expiresAt > Date.now()) {
      return this.fuzzyTermsCache.terms;
    }
    const [brands, models] = await Promise.all([
      this.prisma.tireMasterCatalog.findMany({
        select: { marca: true }, distinct: ['marca'],
      }),
      this.prisma.tireMasterCatalog.findMany({
        select: { modelo: true }, distinct: ['modelo'],
      }),
    ]);
    const set = new Set<string>();
    for (const r of brands) if (r.marca)  set.add(r.marca.toLowerCase());
    for (const r of models) if (r.modelo) set.add(r.modelo.toLowerCase());
    const terms = [...set];
    // Refresh every hour — master catalog edits are rare and distSearch
    // does not need to feel them instantly.
    this.fuzzyTermsCache = { terms, expiresAt: Date.now() + 60 * 60 * 1000 };
    return terms;
  }

  private levenshtein(a: string, b: string, cap: number): number {
    // Early-return if the length delta alone already exceeds the budget
    // — tight loop on the full matrix is only worth it for close pairs.
    if (Math.abs(a.length - b.length) > cap) return cap + 1;
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    let prev = new Array<number>(n + 1);
    let curr = new Array<number>(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      let rowMin = i;
      for (let j = 1; j <= n; j++) {
        curr[j] = a[i - 1] === b[j - 1]
          ? prev[j - 1]
          : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
        if (curr[j] < rowMin) rowMin = curr[j];
      }
      if (rowMin > cap) return cap + 1;
      [prev, curr] = [curr, prev];
    }
    return prev[n];
  }

  /**
   * Given a user-typed token, return the original plus any catalog
   * terms within Levenshtein distance `maxDist`. Pure-numeric tokens
   * (dimension-like "295") skip fuzzy expansion since digit typos
   * don't usually mean a different tire size. Tokens shorter than 4
   * chars also skip — at that length a single edit collapses too
   * many real brands together ("BFG" vs "GFK" etc.).
   */
  private async expandTokenFuzzy(token: string): Promise<string[]> {
    const tok = token.toLowerCase();
    if (!tok || tok.length < 4) return [token];
    if (/^[0-9./-]+$/.test(tok)) return [token];
    // 1 edit per 5 chars, floor, capped at 2. Keeps Continental →
    // Continetal (1 edit) but refuses runaway fuzziness on long strings.
    const maxDist = Math.max(1, Math.min(2, Math.floor(tok.length / 5)));
    const terms = await this.getFuzzyTerms();
    const matches = new Set<string>([token]);
    for (const t of terms) {
      if (t === tok) continue;
      // Cheap prefilter: if t doesn't share at least one of the first
      // two chars with tok, they're almost certainly too far apart.
      if (t[0] !== tok[0] && t[1] !== tok[1]) continue;
      if (this.levenshtein(tok, t, maxDist) <= maxDist) matches.add(t);
    }
    return [...matches];
  }
}
