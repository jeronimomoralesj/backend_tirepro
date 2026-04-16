import { Injectable, Inject, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { EjeType } from '@prisma/client';

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
    const dimension = input.dimension.trim().toLowerCase();

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

  private readonly adminEditableFields = [
    'marca', 'modelo', 'dimension', 'skuRef',
    'anchoMm', 'perfil', 'rin',
    'posicion', 'ejeTirePro', 'terreno', 'pctPavimento', 'pctDestapado',
    'rtdMm', 'indiceCarga', 'indiceVelocidad', 'psiRecomendado', 'pesoKg',
    'kmEstimadosReales', 'kmEstimadosFabrica',
    'reencauchable', 'vidasReencauche',
    'precioCop', 'cpkEstimado',
    'segmento', 'tipo', 'construccion',
    'notasColombia', 'fuente', 'url',
  ];

  private pickEditable(data: Record<string, any>) {
    const out: Record<string, any> = {};
    for (const k of this.adminEditableFields) {
      if (k in data) out[k] = data[k] === '' ? null : data[k];
    }
    return out;
  }

  async adminList(params: { query?: string; marca?: string; dimension?: string; page: number; pageSize: number }) {
    const where: any = {};
    if (params.marca) where.marca = { equals: params.marca, mode: 'insensitive' };
    if (params.dimension) where.dimension = { contains: params.dimension, mode: 'insensitive' };
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
    if (!sku) throw new Error('SKU not found');
    return sku;
  }

  async adminCreate(data: Record<string, any>) {
    const payload = this.pickEditable(data);
    if (!payload.marca || !payload.modelo || !payload.dimension || !payload.skuRef) {
      throw new Error('marca, modelo, dimension and skuRef are required');
    }
    const created = await this.prisma.tireMasterCatalog.create({
      data: { ...payload, fuente: payload.fuente ?? 'admin' },
    });
    await Promise.all([this.cache.del('catalog:brands'), this.cache.del('catalog:dimensions')]);
    return created;
  }

  async adminUpdate(id: string, data: Record<string, any>) {
    const payload = this.pickEditable(data);
    const updated = await this.prisma.tireMasterCatalog.update({
      where: { id },
      data: payload,
    });
    await Promise.all([this.cache.del('catalog:brands'), this.cache.del('catalog:dimensions')]);
    return updated;
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
}
