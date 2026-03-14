import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
  Inject,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { VehicleService } from '../vehicles/vehicle.service';
import { NotificationsService } from '../notifications/notifications.service';
import { S3Service } from './s3.service';
import { CreateTireDto } from './dto/create-tire.dto';
import { UpdateInspectionDto } from './dto/update-inspection.dto';
import { EjeType, TireAlertLevel, TireEventType, Prisma } from '@prisma/client';
import * as XLSX from 'xlsx';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
// =============================================================================
// Domain constants — single source of truth for all business rules
// =============================================================================

const C = {
  KM_POR_MES:                  6_000,
  MS_POR_DIA:                  86_400_000,
  PREMIUM_TIRE_EXPECTED_KM:    120_000,
  STANDARD_TIRE_EXPECTED_KM:   100_000,
  SIGNIFICANT_WEAR_MM:         5,
  RECENT_REGISTRATION_DAYS:    30,
  DEFAULT_PROFUNDIDAD_INICIAL: 22,
  REENCAUCHE_COST:             650_000,
  FALLBACK_TIRE_PRICE:         1_900_000,
  PREMIUM_TIRE_THRESHOLD:      2_100_000,
  LIMITE_LEGAL_MM:             2,
  VIDA_SEQUENCE: ['nueva', 'reencauche1', 'reencauche2', 'reencauche3', 'fin'] as const,
} as const;

type VidaValue = typeof C.VIDA_SEQUENCE[number];

// =============================================================================
// Public-facing DTO / interface types
// =============================================================================

export interface EditTireDto {
  marca?: string;
  diseno?: string;
  dimension?: string;
  eje?: EjeType;
  posicion?: number;
  profundidadInicial?: number;
  kilometrosRecorridos?: number;
  inspectionEdit?: {
    fecha: string;
    profundidadInt: number;
    profundidadCen: number;
    profundidadExt: number;
  };
  costoEdit?: {
    fecha: string;
    newValor: number;
  };
}

export interface TireAnalysis {
  id: string;
  posicion: number;
  profundidadActual: number | null;
  alertLevel: TireAlertLevel;
  healthScore: number;
  recomendaciones: string[];
  cpkTrend: number | null;
  projectedDateEOL: Date | null;
  desechos: unknown;
}

export interface InspectionRow {
  fecha: string;
  profundidadInt: number;
  profundidadCen: number;
  profundidadExt: number;
  diasEnUso: number;
  mesesEnUso: number;
  kilometrosRecorridos: number;
  kmActualVehiculo: number;
  cpk: number;
  cpkProyectado: number;
  cpt: number;
  cptProyectado: number;
  imageUrl?: string;
  kmEfectivos?: number;
  kmProyectado?: number;
}

interface CpkMetrics {
  cpk: number;
  cpt: number;
  cpkProyectado: number;
  cptProyectado: number;
  projectedKm: number;
  projectedMonths: number;
}

// =============================================================================
// Pure utility functions — no side effects, fully testable
// =============================================================================

function toJson(v: unknown): Prisma.InputJsonValue {
  return v as Prisma.InputJsonValue;
}

function safeFloat(v: unknown, fallback = 0): number {
  const n = parseFloat(String(v ?? ''));
  return isNaN(n) ? fallback : n;
}

function safeInt(v: unknown, fallback = 0): number {
  const n = parseInt(String(v ?? ''), 10);
  return isNaN(n) ? fallback : n;
}

function parseCurrency(value: string): number {
  if (!value) return 0;
  const n = parseFloat(value.replace(/[$,\s]/g, '').replace(/[^\d.]/g, ''));
  return isNaN(n) ? 0 : n;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function generateTireId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11).toUpperCase()}`;
}

function needsIdGeneration(id: string): boolean {
  if (!id?.trim()) return true;
  const bad = ['no aplica', 'no visible', 'no space', 'nospace'];
  return bad.some(p => normalize(id).includes(p));
}

function normalizeTipoVHC(t: string): string {
  if (!t) return '';
  const n = normalize(t);
  if (n === 'trailer')  return 'trailer 3 ejes';
  if (n === 'cabezote') return 'cabezote 2 ejes';
  return t.trim().toLowerCase();
}

function normalizeEje(raw: string): EjeType {
  const n = normalize(raw);
  if (n.includes('direcc'))  return EjeType.direccion;
  if (n.includes('tracc'))   return EjeType.traccion;
  if (n.includes('remolq'))  return EjeType.remolque;
  if (n.includes('repuest')) return EjeType.repuesto;
  return EjeType.libre;
}

function calcMinDepth(i: number, c: number, e: number): number {
  return Math.min(i, c, e);
}

function toDateOnly(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/**
 * Core CPK / CPT calculation — single source of truth for all write paths.
 *
 * cpk           = totalCost / km traveled so far
 * cpt           = totalCost / months in use
 * cpkProyectado = totalCost / projected lifetime km (wear-rate extrapolation)
 * projectedKm   = km at which legal tread limit will be reached
 */
function calcCpkMetrics(
  totalCost: number,
  km: number,
  meses: number,
  profundidadInicial: number,
  minDepth: number,
): CpkMetrics {
  const cpk = km    > 0 ? totalCost / km    : 0;
  const cpt = meses > 0 ? totalCost / meses : 0;

  const usableDepth = profundidadInicial - C.LIMITE_LEGAL_MM;
  const mmWorn      = profundidadInicial - minDepth;
  const mmLeft      = Math.max(minDepth - C.LIMITE_LEGAL_MM, 0);
  let   projectedKm = 0;

  if (usableDepth > 0 && km > 0) {
    projectedKm = mmWorn >= C.SIGNIFICANT_WEAR_MM
      ? km + (km / mmWorn) * mmLeft
      : km + (mmLeft / usableDepth) * C.STANDARD_TIRE_EXPECTED_KM;
  }

  const projectedMonths = projectedKm / C.KM_POR_MES;
  const cpkProyectado   = projectedKm     > 0 ? totalCost / projectedKm     : 0;
  const cptProyectado   = projectedMonths > 0 ? totalCost / projectedMonths : 0;

  return { cpk, cpt, cpkProyectado, cptProyectado, projectedKm, projectedMonths };
}

/**
 * Health score: 0–100 composite (ML hook — weights tunable over time).
 *
 * 50%  tread remaining vs initial (linear decay)
 * 30%  CPK trend — negative slope = improving = higher score
 * 20%  wear irregularity penalty (uneven zones = alignment / pressure issues)
 */
function calcHealthScore(
  profundidadInicial: number,
  minDepth: number,
  cpkTrend: number | null,
  pInt: number,
  pCen: number,
  pExt: number,
): number {
  const usable     = Math.max(profundidadInicial - C.LIMITE_LEGAL_MM, 1);
  const remaining  = Math.max(minDepth - C.LIMITE_LEGAL_MM, 0);
  const depthScore = Math.min((remaining / usable) * 100, 100);

  // Clamp slope to ±0.5 CPK/inspection → 0–100
  const trendRaw   = cpkTrend !== null ? cpkTrend : 0;
  const trendScore = Math.min(Math.max(50 - trendRaw * 100, 0), 100);

  const maxDelta   = Math.max(
    Math.abs(pInt - pCen),
    Math.abs(pCen - pExt),
    Math.abs(pInt - pExt),
  );
  const irregScore = Math.max(100 - maxDelta * 15, 0);

  return Math.round(depthScore * 0.5 + trendScore * 0.3 + irregScore * 0.2);
}

/**
 * Linear regression slope over the last N CPK values.
 * Negative = CPK decreasing (tire improving / normalising cost).
 * Positive = CPK rising (degrading efficiency — flag for replacement).
 * null if fewer than 2 data points.
 */
function calcCpkTrend(cpkValues: number[]): number | null {
  if (cpkValues.length < 2) return null;
  const n     = cpkValues.length;
  const xs    = cpkValues.map((_, i) => i);
  const sumX  = xs.reduce((a, b) => a + b, 0);
  const sumY  = cpkValues.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((a, x, i) => a + x * cpkValues[i], 0);
  const sumX2 = xs.reduce((a, x) => a + x * x, 0);
  const denom = n * sumX2 - sumX * sumX;
  return denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
}

function deriveAlertLevel(healthScore: number, minDepth: number): TireAlertLevel {
  if (minDepth <= C.LIMITE_LEGAL_MM) return TireAlertLevel.critical;
  if (healthScore < 25)              return TireAlertLevel.critical;
  if (healthScore < 50)              return TireAlertLevel.warning;
  if (healthScore < 70)              return TireAlertLevel.watch;
  return TireAlertLevel.ok;
}

// =============================================================================
// Excel header maps
// =============================================================================

const HEADER_MAP_A: Record<string, string> = {
  'llanta':               'llanta',
  'numero de llanta':     'llanta',
  'id':                   'llanta',
  'placa vehiculo':       'placa_vehiculo',
  'placa':                'placa_vehiculo',
  'marca':                'marca',
  'diseno':               'diseno_original',
  'diseño':               'diseno_original',
  'dimension':            'dimension',
  'dimensión':            'dimension',
  'eje':                  'eje',
  'posicion':             'posicion',
  'vida':                 'vida',
  'kilometros llanta':    'kilometros_llanta',
  'kilometraje vehiculo': 'kilometros_vehiculo',
  'profundidad int':      'profundidad_int',
  'profundidad cen':      'profundidad_cen',
  'profundidad ext':      'profundidad_ext',
  'profundidad inicial':  'profundidad_inicial',
  'costo':                'costo',
  'cost':                 'costo',
  'precio':               'costo',
  'costo furgon':         'costo',
  'fecha instalacion':    'fecha_instalacion',
  'imageurl':             'imageurl',
  'tipovhc':              'tipovhc',
  'tipo de vehiculo':     'tipovhc',
  'tipo vhc':             'tipovhc',
};

const HEADER_MAP_B: Record<string, string> = {
  'tipo de equipo':      'tipovhc',
  'placa':               'placa_vehiculo',
  'km actual':           'kilometros_vehiculo',
  'pos':                 'posicion',
  '# numero de llanta':  'llanta',
  'numero de llanta':    'llanta',
  'diseño':              'diseno_original',
  'diseno':              'diseno_original',
  'marca':               'marca',
  'marca band':          'marca_banda',
  'banda':               'banda_name',
  'dimensión':           'dimension',
  'dimension':           'dimension',
  'prf int':             'profundidad_int',
  'pro cent':            'profundidad_cen',
  'pro ext':             'profundidad_ext',
  'profundidad inicial': 'profundidad_inicial',
  'tipo llanta':     'tipollanta',
  'tipo de llanta':  'tipollanta',
  'fecha ult ins':   'fecha_inspeccion',
  'fecha ult. ins':  'fecha_inspeccion',
};

function isFormatB(rows: Record<string, string>[]): boolean {
  if (!rows.length) return false;
  return Object.keys(rows[0]).some(k =>
    k.toLowerCase().includes('numero de llanta') ||
    k.toLowerCase().includes('tipo de equipo'),
  );
}

function getCell(
  row: Record<string, string>,
  field: string,
  headerMap: Record<string, string>,
): string {
  const key = Object.keys(row).find(k => {
    const mapped = headerMap[normalize(k)];
    return mapped === field || normalize(k) === field;
  });
  return key ? String(row[key] ?? '') : '';
}

// =============================================================================
// TireService
// =============================================================================

@Injectable()
export class TireService {
  private readonly logger = new Logger(TireService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vehicleService: VehicleService,
    private readonly notificationsService: NotificationsService,
    private readonly s3: S3Service,
    @Inject(CACHE_MANAGER) private cache: Cache,
  ) {}

  // ── Cache helpers ──────────────────────────────────────────────────────────

  private tireKey(companyId: string) {
    return `tires:${companyId}`;
  }

  private async invalidateCompanyCache(companyId: string) {
    await this.cache.del(this.tireKey(companyId));
  }

  // ===========================================================================
  // CREATE SINGLE TIRE
  // ===========================================================================

  async createTire(dto: CreateTireDto) {
    const {
      placa, marca, diseno, profundidadInicial, dimension, eje,
      costo, inspecciones, primeraVida, kilometrosRecorridos, eventos,
      companyId, vehicleId, posicion, desechos, fechaInstalacion,
    } = dto;

    // Validate FK references in parallel — one round trip
    const [company, vehicle] = await Promise.all([
      this.prisma.company.findUnique({ where: { id: companyId }, select: { id: true } }),
      vehicleId
        ? this.prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { id: true } })
        : Promise.resolve(null),
    ]);

    if (!company)              throw new BadRequestException('Invalid companyId');
    if (vehicleId && !vehicle) throw new BadRequestException('Invalid vehicleId');

    // ── Duplicate check ───────────────────────────────────────────────────────
if (placa?.trim()) {
  const normalizedPlaca = placa.trim().toLowerCase();
  const existing = await this.prisma.tire.findFirst({
    where: { placa: normalizedPlaca, companyId },
    include: {
      vehicle: { select: { placa: true, tipovhc: true } },
      inspecciones: { orderBy: { fecha: 'desc' }, take: 1 },
    },
  });

  if (existing) {
    return {
      duplicate: true,
      existingTire: {
        id:        existing.id,
        placa:     existing.placa,
        marca:     existing.marca,
        diseno:    existing.diseno,
        dimension: existing.dimension,
        eje:       existing.eje,
        posicion:  existing.posicion,
        vehicle:   existing.vehicle
          ? { placa: existing.vehicle.placa, tipovhc: existing.vehicle.tipovhc }
          : null,
        suggestedPlaca: normalizedPlaca + '*',
      },
    };
  }
}

    const finalPlaca  = placa?.trim() ? placa.trim().toLowerCase() : generateTireId().toLowerCase();
    const instalacion = fechaInstalacion ? new Date(fechaInstalacion) : new Date();

    // Create tire — vehicleId FK sets the relation automatically, no extra update needed
    const newTire = await this.prisma.tire.create({
      data: {
        placa:                finalPlaca,
        marca:                marca.toLowerCase(),
        diseno:               (diseno ?? '').toLowerCase(),
        profundidadInicial:   profundidadInicial ?? C.DEFAULT_PROFUNDIDAD_INICIAL,
        dimension:            (dimension ?? '').toLowerCase(),
        eje:                  (eje as EjeType) ?? EjeType.libre,
        posicion:             posicion ?? 0,
        kilometrosRecorridos: kilometrosRecorridos ?? 0,
        companyId,
        vehicleId:            vehicleId ?? null,
        fechaInstalacion:     instalacion,
        diasAcumulados:       0,
        alertLevel:           TireAlertLevel.ok,
        primeraVida:          toJson(Array.isArray(primeraVida) ? primeraVida : []),
        desechos:             desechos ?? null,
      },
    });

    // Write normalized child records in parallel now that the tire row exists
    await Promise.all([
      // Inspecciones
      Array.isArray(inspecciones) && inspecciones.length
        ? this.prisma.inspeccion.createMany({
            data: inspecciones.map((insp: InspectionRow) => ({
              tireId:              newTire.id,
              fecha:               new Date(insp.fecha),
              profundidadInt:      insp.profundidadInt,
              profundidadCen:      insp.profundidadCen,
              profundidadExt:      insp.profundidadExt,
              cpk:                 insp.cpk             ?? null,
              cpkProyectado:       insp.cpkProyectado   ?? null,
              cpt:                 insp.cpt             ?? null,
              cptProyectado:       insp.cptProyectado   ?? null,
              diasEnUso:           insp.diasEnUso        ?? null,
              mesesEnUso:          insp.mesesEnUso       ?? null,
              kilometrosEstimados: insp.kilometrosRecorridos ?? null,
              kmActualVehiculo:    insp.kmActualVehiculo ?? null,
              kmEfectivos:         insp.kmEfectivos      ?? null,
              kmProyectado:        insp.kmProyectado     ?? null,
              imageUrl:            insp.imageUrl         ?? null,
            })),
          })
        : Promise.resolve(),

      // Eventos
      Array.isArray(eventos) && eventos.length
        ? this.prisma.tireEvento.createMany({
            data: eventos.map((e: any) => ({
              tireId:   newTire.id,
              tipo:     (e.tipo as TireEventType) ?? TireEventType.montaje,
              fecha:    new Date(e.fecha),
              notas:    e.notas ?? null,
              // Prisma requires JsonNull (not JS null) for nullable Json columns
              metadata: e.metadata ? toJson(e.metadata) : Prisma.JsonNull,
            })),
          })
        : Promise.resolve(),

      // Costos
      Array.isArray(costo) && costo.length
        ? this.prisma.tireCosto.createMany({
            data: costo.map((c: any) => ({
              tireId: newTire.id,
              valor:  c.valor,
              fecha:  new Date(c.fecha),
            })),
          })
        : Promise.resolve(),
    ]);

    // Populate all cached analytics columns after children are written
    await this.invalidateCompanyCache(dto.companyId);
    return this.refreshTireAnalyticsCache(newTire.id);
  }

  // ===========================================================================
  // BULK UPLOAD
  // ===========================================================================

  async bulkUploadTires(file: { buffer: Buffer }, companyId: string) {
    const wb    = XLSX.read(file.buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows: Record<string, string>[] = XLSX.utils.sheet_to_json(sheet, {
      raw: false, defval: '',
    });

    const fmtB      = isFormatB(rows);
    const headerMap = fmtB ? HEADER_MAP_B : HEADER_MAP_A;
    const get       = (row: Record<string, string>, f: string) => getCell(row, f, headerMap);

    this.logger.log(`Bulk upload: Format ${fmtB ? 'B' : 'A'}, ${rows.length} rows`);

    const processedIds = new Set<string>();
    const errors:   string[] = [];
    const warnings: string[] = [];

    let lastTipoVHC = '';
    let lastPlaca   = '';

    for (let i = 0; i < rows.length; i++) {
      const row    = rows[i];
      const rowNum = i + 2; // 1-based + header

      try {
        // ── Carry-forward for sparse Format B ────────────────────────────────
        if (fmtB) {
          const tv = get(row, 'tipovhc')?.trim();
          const pl = get(row, 'placa_vehiculo')?.trim();
          if (tv) lastTipoVHC = tv;
          if (pl) lastPlaca   = pl;
        }

        // ── Tire ID ───────────────────────────────────────────────────────────
        const rawId     = get(row, 'llanta')?.trim();
        const tirePlaca = needsIdGeneration(rawId)
          ? generateTireId().toLowerCase()
          : rawId.toLowerCase();

        if (processedIds.has(tirePlaca)) {
          const hasVehicleCtx = !!(fmtB
            ? get(row, 'placa_vehiculo')?.trim() || lastPlaca
            : get(row, 'placa_vehiculo')?.trim());
          if (!hasVehicleCtx) {
            errors.push(`Row ${rowNum}: Duplicate tire ID "${tirePlaca}" with no vehicle context. Skipped.`);
            continue;
          }
        }
        processedIds.add(tirePlaca);

        // ── Core fields ───────────────────────────────────────────────────────
        const marcaRaw  = get(row, 'marca').trim();
        const marca     = marcaRaw.charAt(0).toUpperCase() + marcaRaw.slice(1).toLowerCase();
        const diseno    = get(row, 'diseno_original').toLowerCase();
        const dimension = get(row, 'dimension').toLowerCase();
        const posicion  = safeInt(get(row, 'posicion'), 0);
        const eje       = normalizeEje(fmtB ? get(row, 'tipollanta') : get(row, 'eje'));

        let tipovhc = fmtB
          ? (get(row, 'tipovhc')?.trim() || lastTipoVHC)
          : get(row, 'tipovhc')?.trim();
        tipovhc = normalizeTipoVHC(tipovhc);

        // ── Depth readings ────────────────────────────────────────────────────
        const profInt  = safeFloat(get(row, 'profundidad_int'));
        const profCen  = safeFloat(get(row, 'profundidad_cen'));
        const profExt  = safeFloat(get(row, 'profundidad_ext'));
        const hasInsp  = profInt > 0 || profCen > 0 || profExt > 0;
        const minDepth = hasInsp ? calcMinDepth(profInt, profCen, profExt) : 0;

        // ── Initial depth inference ───────────────────────────────────────────
        let profundidadInicial = safeFloat(get(row, 'profundidad_inicial'));
        if (profundidadInicial <= 0) {
          const maxObs = Math.max(profInt, profCen, profExt);
          profundidadInicial = maxObs > 0
            ? (maxObs > C.DEFAULT_PROFUNDIDAD_INICIAL ? maxObs + 1 : C.DEFAULT_PROFUNDIDAD_INICIAL)
            : C.DEFAULT_PROFUNDIDAD_INICIAL;
          warnings.push(`Row ${rowNum}: profundidadInicial inferred as ${profundidadInicial}mm`);
        }

        // ── Vida ──────────────────────────────────────────────────────────────
        let vidaValor       = '';
        let needsReencauche = false;
        let bandaName       = '';

        if (fmtB) {
          const marcaBanda = normalize(get(row, 'marca_banda'));
          bandaName        = get(row, 'banda_name').toLowerCase();
          needsReencauche  = marcaBanda.includes('reencauche') || marcaBanda.includes('rencauche');
          vidaValor        = 'nueva';
        } else {
          vidaValor = get(row, 'vida').trim().toLowerCase();
          if (vidaValor === 'rencauche' || vidaValor === 'reencauche') vidaValor = 'reencauche1';
        }

        // ── Vehicle lookup / create ───────────────────────────────────────────
        const placaVehiculo = (fmtB
          ? (get(row, 'placa_vehiculo')?.trim() || lastPlaca)
          : get(row, 'placa_vehiculo')?.trim()
        )?.toLowerCase();

        const kmVehiculo = safeFloat(get(row, 'kilometros_vehiculo'));

        let vehicle: any = null;
        if (placaVehiculo) {
          vehicle = await this.prisma.vehicle.findFirst({ where: { placa: placaVehiculo } });
          if (!vehicle) {
            vehicle = await this.vehicleService.createVehicle({
              placa: placaVehiculo, kilometrajeActual: kmVehiculo,
              carga: '', pesoCarga: 0, tipovhc, companyId, cliente: '',
            });
          } else if (kmVehiculo > (vehicle.kilometrajeActual || 0)) {
            await this.vehicleService.updateKilometraje(vehicle.id, kmVehiculo);
            vehicle.kilometrajeActual = kmVehiculo;
          }
          if (vehicle && tipovhc && !vehicle.tipovhc) {
            await this.prisma.vehicle.update({
              where: { id: vehicle.id },
              data:  { tipovhc },
            });
          }
        }

        // ── Cost (with fallback) ──────────────────────────────────────────────
        const costoRaw = get(row, 'costo');
        let costoCell  = parseCurrency(costoRaw);
        if (costoCell <= 0) {
          costoCell = await this.fetchFallbackPrice(marca, diseno, dimension);
          warnings.push(`Row ${rowNum}: Cost fallback used — $${costoCell}`);
        }

        // ── KM estimation: excel km → vehicle odometer → wear → time ─────────
        const fechaInstalacion  = new Date(Date.now()); // tire install date = today
        const rawFechaInsp      = get(row, 'fecha_inspeccion')?.trim();
        const fechaInspeccion   = rawFechaInsp ? new Date(rawFechaInsp) : fechaInstalacion;
        const now              = new Date();
        const isPremium        = costoCell >= C.PREMIUM_TIRE_THRESHOLD;
        const kmLlantaExcel    = safeFloat(get(row, 'kilometros_llanta'));
        const usableDepth      = profundidadInicial - C.LIMITE_LEGAL_MM;
        const mmWorn           = profundidadInicial - minDepth;
        const tempDias = Math.max(
          Math.floor((now.getTime() - fechaInspeccion.getTime()) / C.MS_POR_DIA),
          1,
        );

        let kmEstimados   = 0;
        let shouldEstTime = false;

        if (kmLlantaExcel > 0) {
          kmEstimados = kmLlantaExcel;
        } else if (kmVehiculo > 0) {
          kmEstimados = kmVehiculo;
        } else if (hasInsp && mmWorn > 0 && usableDepth > 0) {
          const lifetime = isPremium ? C.PREMIUM_TIRE_EXPECTED_KM : C.STANDARD_TIRE_EXPECTED_KM;
          kmEstimados    = Math.round((lifetime / usableDepth) * mmWorn);
          shouldEstTime  = true;
          warnings.push(`Row ${rowNum}: KM estimated from wear — ${kmEstimados} km`);
        } else {
          kmEstimados = Math.round((tempDias / 30) * C.KM_POR_MES);
        }

        let diasEnUso = tempDias;
        if (shouldEstTime && tempDias < C.RECENT_REGISTRATION_DAYS && kmEstimados > 0) {
          diasEnUso = Math.max(Math.round(kmEstimados / (C.KM_POR_MES / 30)), 1);
        }
        const mesesEnUso = diasEnUso / 30;

        // ── Match existing tire (by placa, then by vehicle + position) ────────
        let existing: any = null;
        if (!needsIdGeneration(rawId)) {
          existing = await this.prisma.tire.findFirst({ where: { placa: tirePlaca } });
        }
        if (!existing && vehicle && posicion > 0) {
          existing = await this.prisma.tire.findFirst({
            where: { vehicleId: vehicle.id, posicion },
          });
        }

        // ── Branch A: existing tire — append inspection ───────────────────────
        if (existing) {
          if (hasInsp) {
            const priorKm   = existing.kilometrosRecorridos || 0;
            const inspKm    = Math.max(kmEstimados, priorKm);
            const totalCost = await this.sumCostoById(existing.id);
            const metrics   = calcCpkMetrics(
              totalCost, inspKm, mesesEnUso,
              existing.profundidadInicial || profundidadInicial,
              minDepth,
            );

            await this.prisma.inspeccion.create({
              data: {
                tireId:              existing.id,
                fecha:               fechaInstalacion,
                profundidadInt:      profInt,
                profundidadCen:      profCen,
                profundidadExt:      profExt,
                cpk:                 metrics.cpk,
                cpkProyectado:       metrics.cpkProyectado,
                cpt:                 metrics.cpt,
                cptProyectado:       metrics.cptProyectado,
                diasEnUso,
                mesesEnUso,
                kilometrosEstimados: inspKm,
                kmActualVehiculo:    kmVehiculo || 0,
                kmEfectivos:         inspKm,
                kmProyectado:        metrics.projectedKm,
                imageUrl:            get(row, 'imageurl') || null,
              },
            });

            await this.prisma.tire.update({
              where: { id: existing.id },
              data:  { kilometrosRecorridos: inspKm, diasAcumulados: diasEnUso },
            });

            await this.refreshTireAnalyticsCache(existing.id);
          }

        // ── Branch B: new tire ────────────────────────────────────────────────
        } else {
          let finalTirePlaca = tirePlaca;
          const alreadyExists = await this.prisma.tire.findFirst({ where: { placa: tirePlaca, companyId } });
          if (alreadyExists) {
            finalTirePlaca = tirePlaca + '*';
            warnings.push(`Row ${rowNum}: ID "${tirePlaca}" duplicado — guardado como "${finalTirePlaca}"`);
          }

          const newTire = await this.prisma.tire.create({
            data: {
              placa: finalTirePlaca,
              marca,
              diseno,
              dimension,
              eje:                  (eje as EjeType) || EjeType.libre,
              posicion,
              profundidadInicial,
              companyId,
              vehicleId:            vehicle?.id ?? null,
              fechaInstalacion,
              kilometrosRecorridos: kmEstimados,
              diasAcumulados:       diasEnUso,
              alertLevel:           TireAlertLevel.ok,
              primeraVida:          toJson([]),
            },
          });

          // Cost record
          if (costoCell > 0) {
            await this.prisma.tireCosto.create({
              data: { tireId: newTire.id, valor: costoCell, fecha: now },
            });
          }

          // Vida as TireEvento
          if (vidaValor) {
            await this.prisma.tireEvento.create({
              data: {
                tireId:   newTire.id,
                tipo:     TireEventType.montaje,
                fecha:    fechaInstalacion,
                notas:    vidaValor,
                metadata: toJson({ vidaValor }),
              },
            });
          }

          // First inspection
          if (hasInsp) {
            const metrics = calcCpkMetrics(
              costoCell, kmEstimados, mesesEnUso, profundidadInicial, minDepth,
            );

            await this.prisma.inspeccion.create({
              data: {
                tireId:              newTire.id,
                fecha:               fechaInspeccion,
                profundidadInt:      profInt,
                profundidadCen:      profCen,
                profundidadExt:      profExt,
                cpk:                 metrics.cpk,
                cpkProyectado:       metrics.cpkProyectado,
                cpt:                 metrics.cpt,
                cptProyectado:       metrics.cptProyectado,
                diasEnUso,
                mesesEnUso,
                kilometrosEstimados: kmEstimados,
                kmActualVehiculo:    kmVehiculo || 0,
                kmEfectivos:         kmEstimados,
                kmProyectado:        metrics.projectedKm,
                imageUrl:            get(row, 'imageurl') || null,
              },
            });
          }

          // Auto-reencauche for Format B retread tires
          if (needsReencauche) {
            try {
              await this.updateVida(
                newTire.id, 'reencauche1',
                bandaName || diseno,
                C.REENCAUCHE_COST,
                profundidadInicial,
              );
            } catch (e: any) {
              errors.push(`Row ${rowNum}: Reencauche failed for "${finalTirePlaca}" — ${e.message}`);
            }
          }

          await this.refreshTireAnalyticsCache(newTire.id);
        }

      } catch (err: any) {
        this.logger.error(`Row ${rowNum} failed: ${err.message}`, err.stack);
        errors.push(`Row ${rowNum}: Unexpected error — ${err.message}`);
      }
    }
    await this.invalidateCompanyCache(companyId);
    return {
      message:  `Carga completada. ${processedIds.size} llantas procesadas. ${warnings.length} advertencias. ${errors.length} errores.`,
      success:  processedIds.size,
      errors:   errors.length,
      warnings: warnings.length,
      details:  { errors, warnings },
    };
  }

  // ===========================================================================
  // READ
  // ===========================================================================

  async findTiresByCompany(companyId: string) {
  const cached = await this.cache.get(this.tireKey(companyId));
  if (cached) return cached;

  const tires = await this.prisma.tire.findMany({
    where: { companyId },
    include: {
      inspecciones: { orderBy: { fecha: 'desc' } },
      costos: true,
      eventos: true,
    },
  });

  await this.cache.set(this.tireKey(companyId), tires, 60 * 60 * 1000); // ← 1 hour
  return tires;
}

  async findTiresByVehicle(vehicleId: string) {
    if (!vehicleId) throw new BadRequestException('vehicleId is required');
    return this.prisma.tire.findMany({
      where:   { vehicleId },
      include: {
        inspecciones: { orderBy: { fecha: 'desc' } },
        costos:       { orderBy: { fecha: 'asc'  } },
        eventos:      { orderBy: { fecha: 'asc'  } },
      },
    });
  }

  async findAllTires() {
    return this.prisma.tire.findMany({
      include: { inspecciones: { orderBy: { fecha: 'desc' }, take: 1 } },
    });
  }

  // ===========================================================================
  // UPDATE INSPECTION
  // ===========================================================================

  async updateInspection(tireId: string, dto: UpdateInspectionDto) {
    // No-op guard — all three zones at zero means nothing to record
    if (dto.profundidadInt === 0 && dto.profundidadCen === 0 && dto.profundidadExt === 0) {
      return this.prisma.tire.findUnique({ where: { id: tireId } });
    }

    const tire = await this.prisma.tire.findUnique({
      where:   { id: tireId },
      include: {
        costos:       { orderBy: { fecha: 'asc'  } },
        inspecciones: { orderBy: { fecha: 'desc' }, take: 5 },
        vehicle:      true,
      },
    });
    if (!tire)           throw new NotFoundException('Tire not found');
    if (!tire.vehicleId) throw new BadRequestException('Tire is not associated with a vehicle');

    const vehicle      = tire.vehicle!;
    const newVehicleKm = dto.newKilometraje || 0;
    const odometerSent = newVehicleKm > 0;
    const priorTireKm  = tire.kilometrosRecorridos || 0;

    // ── KM delta — three fallback strategies in priority order ────────────────
    let kilometrosRecorridos: number;
    const kmDelta = (dto as any).kmDelta ?? 0;

    if (kmDelta > 0) {
      // Frontend sent explicit delta — most precise
      kilometrosRecorridos = priorTireKm + kmDelta;
    } else if (odometerSent && tire.inspecciones.length > 0) {
      // Derive delta from last known vehicle odometer stored in prior inspection
      const lastKnownVehicleKm =
        tire.inspecciones[0].kmActualVehiculo ?? vehicle.kilometrajeActual ?? 0;
      kilometrosRecorridos = priorTireKm + Math.max(newVehicleKm - lastKnownVehicleKm, 0);
    } else {
      kilometrosRecorridos = priorTireKm;
    }

    // ── Time in use ───────────────────────────────────────────────────────────
    const now              = new Date();
    const fechaInstalacion = tire.fechaInstalacion ?? now;
    const diasEnUso        = Math.max(
      Math.floor((now.getTime() - new Date(fechaInstalacion).getTime()) / C.MS_POR_DIA),
      1,
    );
    const mesesEnUso = diasEnUso / 30;

    // ── Depth + metrics ───────────────────────────────────────────────────────
    const minDepth    = calcMinDepth(dto.profundidadInt, dto.profundidadCen, dto.profundidadExt);
    const effectiveKm = kilometrosRecorridos > 0
      ? kilometrosRecorridos
      : Math.round(mesesEnUso * C.KM_POR_MES);

    const totalCost = tire.costos.reduce((s, c) => s + c.valor, 0);
    const metrics   = calcCpkMetrics(
      totalCost, effectiveKm, mesesEnUso, tire.profundidadInicial, minDepth,
    );

    // ── Optional image upload to S3 ───────────────────────────────────────────
    let finalImageUrl = dto.imageUrl ?? null;
    if (dto.imageUrl?.startsWith('data:')) {
      const [header, b64] = dto.imageUrl.split(',');
      const mime = header.match(/data:(image\/\w+);/)?.[1] ?? 'image/jpeg';
      finalImageUrl = await this.s3.uploadInspectionImage(
        Buffer.from(b64, 'base64'), tireId, mime,
      );
    }

    // ── Write new Inspeccion row ──────────────────────────────────────────────
    await this.prisma.inspeccion.create({
      data: {
        tireId,
        fecha:               now,
        profundidadInt:      dto.profundidadInt,
        profundidadCen:      dto.profundidadCen,
        profundidadExt:      dto.profundidadExt,
        cpk:                 metrics.cpk,
        cpkProyectado:       metrics.cpkProyectado,
        cpt:                 metrics.cpt,
        cptProyectado:       metrics.cptProyectado,
        diasEnUso,
        mesesEnUso,
        kilometrosEstimados: kilometrosRecorridos,
        kmActualVehiculo:    odometerSent ? newVehicleKm : (vehicle.kilometrajeActual || 0),
        kmEfectivos:         effectiveKm,
        kmProyectado:        metrics.projectedKm,
        imageUrl:            finalImageUrl,
      },
    });

    // ── Persist tire scalars + vehicle odometer in parallel ───────────────────
    await Promise.all([
      this.prisma.tire.update({
        where: { id: tireId },
        data:  {
          kilometrosRecorridos,
          diasAcumulados:     diasEnUso,
          lastInspeccionDate: now,
        },
      }),
      odometerSent
        ? this.prisma.vehicle.update({
            where: { id: vehicle.id },
            data:  { kilometrajeActual: newVehicleKm },
          })
        : Promise.resolve(),
    ]);

    // ── Refresh all cached analytics columns ──────────────────────────────────
    const updatedTire = await this.refreshTireAnalyticsCache(tireId);

    // ── Generate / clear notifications ───────────────────────────────────────
    await this.notificationsService.deleteByTire(tireId);

    if (updatedTire.alertLevel !== TireAlertLevel.ok) {
      const analysis = this.buildTireAnalysis(updatedTire);
      await this.notificationsService.createNotification({
        title:     `Llantas — ${updatedTire.alertLevel === TireAlertLevel.critical ? 'Crítico' : 'Precaución'}`,
        message:   analysis.recomendaciones[0] ?? '',
        type:      updatedTire.alertLevel === TireAlertLevel.critical ? 'critical' : 'warning',
        tireId:    updatedTire.id,
        vehicleId: updatedTire.vehicleId ?? undefined,
        companyId: updatedTire.companyId,
      });
    }
    await this.invalidateCompanyCache(tire.companyId);
    return updatedTire;
  }

  // ===========================================================================
  // UPDATE VIDA
  // ===========================================================================

  async updateVida(
    tireId: string,
    newValor: string | undefined,
    banda?: string,
    costo?: number,
    profundidadInicial?: number | string,
    proveedor?: string,
    desechoData?: { causales: string; milimetrosDesechados: number; imageUrls?: string[] },
  ) {
    if (!newValor) throw new BadRequestException(`El campo 'valor' es obligatorio`);

    const normalizedValor = newValor.toLowerCase() as VidaValue;
    const newIndex        = C.VIDA_SEQUENCE.indexOf(normalizedValor);
    if (newIndex < 0) throw new BadRequestException(`"${newValor}" no es un valor válido`);

    // Validate profundidadInicial for all states except 'fin'
    let parsedProfundidad: number | null = null;
    if (normalizedValor !== 'fin') {
      if (profundidadInicial === undefined || profundidadInicial === null || profundidadInicial === '') {
        throw new BadRequestException('La profundidad inicial es requerida.');
      }
      parsedProfundidad = typeof profundidadInicial === 'string'
        ? parseFloat(profundidadInicial)
        : Number(profundidadInicial);
      if (isNaN(parsedProfundidad) || parsedProfundidad <= 0) {
        throw new BadRequestException('La profundidad inicial debe ser mayor a 0.');
      }
    }

    const tire = await this.prisma.tire.findUnique({
      where:   { id: tireId },
      include: {
        eventos:      { orderBy: { fecha: 'asc'  } },
        inspecciones: { orderBy: { fecha: 'desc' }, take: 1 },
        costos:       { orderBy: { fecha: 'asc'  } },
      },
    });
    if (!tire) throw new NotFoundException('Tire not found');

    // Enforce forward-only vida sequence via TireEvento records
    const vidaEventos = tire.eventos.filter(e =>
      e.notas && C.VIDA_SEQUENCE.includes(e.notas as VidaValue),
    );
    if (vidaEventos.length) {
      const lastVida  = vidaEventos[vidaEventos.length - 1].notas as VidaValue;
      const lastIndex = C.VIDA_SEQUENCE.indexOf(lastVida);
      if (newIndex <= lastIndex) {
        throw new BadRequestException(
          `Debe avanzar en la secuencia. Último valor: "${lastVida}".`,
        );
      }
    }

    const now        = new Date();
    const updateData: Prisma.TireUpdateInput = {};

    if (normalizedValor !== 'fin' && parsedProfundidad !== null) {
      updateData.profundidadInicial = parsedProfundidad;
    }
    if (banda?.trim()) updateData.diseno = banda.trim();

    // Write vida state as a TireEvento (queryable history)
    await this.prisma.tireEvento.create({
      data: {
        tireId,
        tipo:     TireEventType.montaje,
        fecha:    now,
        notas:    normalizedValor,
        metadata: toJson({ vidaValor: normalizedValor, proveedor: proveedor ?? null }),
      },
    });

    // Reencauche: add new cost entry
    if (normalizedValor.startsWith('reencauche')) {
      const costoValue = typeof costo === 'number' && costo > 0
        ? costo
        : (tire.costos.at(-1)?.valor ?? 0);

      if (costoValue > 0) {
        await this.prisma.tireCosto.create({
          data: { tireId, valor: costoValue, fecha: now },
        });
      }
    }

    // Reencauche1: snapshot first-life metrics into primeraVida (JSON comparison store)
    if (normalizedValor === 'reencauche1') {
      const lastInsp    = tire.inspecciones[0];
      const cpk         = lastInsp?.cpk ?? 0;
      const designValue = banda?.trim() || tire.diseno;
      const costoVal    = typeof costo === 'number' && costo > 0
        ? costo
        : (tire.costos.at(-1)?.valor ?? 0);

      updateData.primeraVida = toJson([{
        diseno:     designValue,
        cpk,
        costo:      costoVal,
        kilometros: tire.kilometrosRecorridos || 0,
      }]);
    }

    // Fin: detach from vehicle (disconnect via relation — vehicleId is not directly
    // settable on TireUpdateInput; must use the nested vehicle relation instead)
    if (normalizedValor === 'fin') {
      if (!desechoData?.causales || desechoData.milimetrosDesechados === undefined) {
        throw new BadRequestException('Información de desecho incompleta');
      }

      let finalImageUrls: string[] = [];
      if (Array.isArray(desechoData.imageUrls) && desechoData.imageUrls.length > 0) {
        finalImageUrls = await Promise.all(
          desechoData.imageUrls.slice(0, 3).map(async (img, idx) => {
            if (img.startsWith('data:')) {
              const [header, b64] = img.split(',');
              const mime = header.match(/data:(image\/\w+);/)?.[1] ?? 'image/jpeg';
              return this.s3.uploadDesechoImage(
                Buffer.from(b64, 'base64'),
                tireId,
                idx,
                mime,
              );
            }
            return img;
          }),
        );
      }

      updateData.vehicle = { disconnect: true };

      const lastInsp    = tire.inspecciones[0];
      const cpkActual   = lastInsp?.cpk ?? 0;
      const usableDepth = (tire.profundidadInicial ?? 0) - C.LIMITE_LEGAL_MM;
      const kmPerMm     = usableDepth > 0 && tire.kilometrosRecorridos > 0
        ? tire.kilometrosRecorridos / usableDepth
        : 0;

      updateData.desechos = toJson({
        causales:             desechoData.causales,
        milimetrosDesechados: desechoData.milimetrosDesechados,
        remanente:            Number((cpkActual * kmPerMm * desechoData.milimetrosDesechados).toFixed(2)),
        fecha:                now.toISOString(),
        imageUrls:            finalImageUrls,
      });
    }

    const finalTire = await this.prisma.tire.update({
      where:   { id: tireId },
      data:    updateData,
      include: { inspecciones: true, costos: true, eventos: true },
    });

    await this.notificationsService.deleteByTire(tireId);
    await this.invalidateCompanyCache(tire.companyId);
    return finalTire;
  }

  // ===========================================================================
  // UPDATE EVENTO
  // ===========================================================================

  async updateEvento(tireId: string, newValor: string) {
  const tire = await this.prisma.tire.findUnique({
    where:  { id: tireId },
    select: { id: true, companyId: true },
  });
  if (!tire) throw new NotFoundException('Tire not found');

  await this.prisma.tireEvento.create({
    data: {
      tireId,
      tipo:  TireEventType.inspeccion,
      fecha: new Date(),
      notas: newValor,
    },
  });

  await this.invalidateCompanyCache(tire.companyId);

  return this.prisma.tire.findUnique({
    where:   { id: tireId },
    include: { eventos: { orderBy: { fecha: 'asc' } } },
  });
}

  // ===========================================================================
  // UPDATE POSITIONS
  // ===========================================================================

  async updatePositions(placa: string, updates: Record<string, string | string[]>) {
  const vehicle = await this.prisma.vehicle.findFirst({
    where:  { placa },
    select: { id: true, companyId: true },
  });
  if (!vehicle) throw new NotFoundException('Vehicle not found');

  await this.prisma.$transaction(
    Object.entries(updates).flatMap(([pos, ids]) =>
      (Array.isArray(ids) ? ids : [ids]).map(tireId =>
        this.prisma.tire.update({
          where: { id: tireId },
          data:  {
            posicion:  parseInt(pos, 10) || 0,
            vehicleId: vehicle.id,
          },
        }),
      ),
    ),
  );

  await this.invalidateCompanyCache(vehicle.companyId); // ← add this
  return { message: 'Positions updated successfully' };
}

  // ===========================================================================
  // ANALYZE TIRES FOR VEHICLE
  // ===========================================================================

  async analyzeTires(vehiclePlaca: string) {
    const vehicle = await this.prisma.vehicle.findFirst({ where: { placa: vehiclePlaca } });
    if (!vehicle) throw new NotFoundException(`Vehicle ${vehiclePlaca} not found`);

    const tires = await this.prisma.tire.findMany({
      where:   { vehicleId: vehicle.id },
      include: {
        inspecciones: { orderBy: { fecha: 'desc' }, take: 5 },
        costos:       true,
      },
    });
    if (!tires.length) throw new NotFoundException(`No tires for vehicle ${vehiclePlaca}`);

    return { vehicle, tires: tires.map(t => this.buildTireAnalysis(t)) };
  }

  // ===========================================================================
  // REMOVE INSPECTION
  // ===========================================================================

  async removeInspection(tireId: string, fecha: string) {
  const insp = await this.prisma.inspeccion.findFirst({
    where:  { tireId, fecha: new Date(fecha) },
    select: { id: true },
  });
  if (!insp) throw new NotFoundException('Inspection not found');

  // ← add this
  const { companyId } = await this.prisma.tire.findUniqueOrThrow({
    where:  { id: tireId },
    select: { companyId: true },
  });

  await this.prisma.inspeccion.delete({ where: { id: insp.id } });
  await this.refreshTireAnalyticsCache(tireId);
  await this.invalidateCompanyCache(companyId); // ← add this
  return { message: 'Inspección eliminada' };
}

  // ===========================================================================
  // ASSIGN / UNASSIGN TIRES
  // ===========================================================================

  async assignTiresToVehicle(vehiclePlaca: string, tireIds: string[]) {
  const vehicle = await this.prisma.vehicle.findFirst({
    where:  { placa: vehiclePlaca },
    select: { id: true, companyId: true }, // ← add companyId to select
  });
  if (!vehicle) throw new NotFoundException('Vehicle not found');

  await this.prisma.tire.updateMany({
    where: { id: { in: tireIds } },
    data:  { vehicleId: vehicle.id },
  });

  await this.invalidateCompanyCache(vehicle.companyId); // ← add this
  return { message: 'Tires assigned successfully', count: tireIds.length };
}

  async unassignTiresFromVehicle(tireIds: string[]) {
  // ← add this lookup to get companyId before we nullify vehicleId
  const sample = await this.prisma.tire.findFirst({
    where:  { id: { in: tireIds } },
    select: { companyId: true },
  });

  await this.prisma.tire.updateMany({
    where: { id: { in: tireIds } },
    data:  { vehicleId: null, posicion: 0 },
  });

  if (sample) await this.invalidateCompanyCache(sample.companyId); // ← add this
  return { message: 'Tires unassigned successfully', count: tireIds.length };
}

  // ===========================================================================
  // EDIT TIRE
  // ===========================================================================

  async editTire(tireId: string, dto: EditTireDto) {
    const tire = await this.prisma.tire.findUnique({
      where:   { id: tireId },
      include: {
        costos:       { orderBy: { fecha: 'asc' } },
        inspecciones: { orderBy: { fecha: 'asc' } },
      },
    });
    if (!tire) throw new NotFoundException('Tire not found');

    const updateData: Prisma.TireUpdateInput = {};

    // ── 1. Scalar identity fields ─────────────────────────────────────────────
    if (dto.marca              !== undefined) updateData.marca              = dto.marca;
    if (dto.diseno             !== undefined) updateData.diseno             = dto.diseno;
    if (dto.dimension          !== undefined) updateData.dimension          = dto.dimension;
    if (dto.eje                !== undefined) updateData.eje                = dto.eje;
    if (dto.posicion           !== undefined) updateData.posicion           = dto.posicion;
    if (dto.profundidadInicial !== undefined) updateData.profundidadInicial = dto.profundidadInicial;

    if (
      dto.kilometrosRecorridos !== undefined &&
      dto.kilometrosRecorridos !== tire.kilometrosRecorridos
    ) {
      updateData.kilometrosRecorridos = dto.kilometrosRecorridos;
    }

    // ── 2. Inspection depth edit — recalculate that row's metrics ─────────────
    if (dto.inspectionEdit) {
      const { fecha, profundidadInt, profundidadCen, profundidadExt } = dto.inspectionEdit;

      const insp = await this.prisma.inspeccion.findFirst({
        where:  { tireId, fecha: new Date(fecha) },
        select: { id: true, mesesEnUso: true, kilometrosEstimados: true },
      });
      if (!insp) throw new NotFoundException('Inspection not found');

      const profInicial = dto.profundidadInicial ?? tire.profundidadInicial;
      const costToDate  = tire.costos
        .filter(c => toDateOnly(c.fecha.toISOString()) <= toDateOnly(fecha))
        .reduce((s, c) => s + c.valor, 0);
      const minDepth    = calcMinDepth(profundidadInt, profundidadCen, profundidadExt);
      const km          = insp.kilometrosEstimados ?? tire.kilometrosRecorridos ?? 0;
      const metrics     = calcCpkMetrics(costToDate, km, insp.mesesEnUso ?? 1, profInicial, minDepth);

      await this.prisma.inspeccion.update({
        where: { id: insp.id },
        data:  {
          profundidadInt,
          profundidadCen,
          profundidadExt,
          cpk:           metrics.cpk,
          cpkProyectado: metrics.cpkProyectado,
          cpt:           metrics.cpt,
          cptProyectado: metrics.cptProyectado,
          kmProyectado:  metrics.projectedKm,
        },
      });
    }

    // ── 3. Cost edit — recalculate all inspections on/after the cost date ─────
    if (dto.costoEdit) {
      const { fecha: costoFecha, newValor } = dto.costoEdit;

      const costo = await this.prisma.tireCosto.findFirst({
        where:  { tireId, fecha: new Date(costoFecha) },
        select: { id: true },
      });
      if (!costo) throw new NotFoundException('Cost entry not found');

      await this.prisma.tireCosto.update({
        where: { id: costo.id },
        data:  { valor: newValor },
      });

      // Apply edited value to in-memory cost list for recalculation
      const updatedCostos = tire.costos.map(c =>
        toDateOnly(c.fecha.toISOString()) === toDateOnly(costoFecha)
          ? { ...c, valor: newValor }
          : c,
      );

      const affectedInsps = tire.inspecciones.filter(
        i => toDateOnly(i.fecha.toISOString()) >= toDateOnly(costoFecha),
      );

      await Promise.all(
        affectedInsps.map(insp => {
          const costToDate  = updatedCostos
            .filter(c => toDateOnly(c.fecha.toISOString()) <= toDateOnly(insp.fecha.toISOString()))
            .reduce((s, c) => s + c.valor, 0);
          const minDepth    = calcMinDepth(insp.profundidadInt, insp.profundidadCen, insp.profundidadExt);
          const km          = insp.kilometrosEstimados ?? tire.kilometrosRecorridos ?? 0;
          const profInicial = dto.profundidadInicial ?? tire.profundidadInicial;
          const metrics     = calcCpkMetrics(costToDate, km, insp.mesesEnUso ?? 1, profInicial, minDepth);

          return this.prisma.inspeccion.update({
            where: { id: insp.id },
            data:  {
              cpk:           metrics.cpk,
              cpkProyectado: metrics.cpkProyectado,
              cpt:           metrics.cpt,
              cptProyectado: metrics.cptProyectado,
              kmProyectado:  metrics.projectedKm,
            },
          });
        }),
      );
    }

    // ── 4. Persist scalar changes ─────────────────────────────────────────────
    if (Object.keys(updateData).length > 0) {
      await this.prisma.tire.update({ where: { id: tireId }, data: updateData });
    }

    // ── 5. Refresh full analytics cache ───────────────────────────────────────
    await this.invalidateCompanyCache(tire.companyId);
    return this.refreshTireAnalyticsCache(tireId);
  }

  // ===========================================================================
  // ANALYTICS CACHE REFRESH
  // Called after every write that changes inspection data.
  // Populates all cached columns so dashboard reads are O(1).
  // This is the core ML hook — healthScore, cpkTrend, alertLevel, projectedEOL
  // are all written here and read by dashboards without recomputing.
  // ===========================================================================

  async refreshTireAnalyticsCache(tireId: string) {
    const tire = await this.prisma.tire.findUnique({
      where:   { id: tireId },
      include: {
        inspecciones: { orderBy: { fecha: 'asc' } },
        costos:       { orderBy: { fecha: 'asc' } },
      },
    });
    if (!tire) throw new NotFoundException('Tire not found for cache refresh');

    const inspecciones = tire.inspecciones;

    // No inspections yet — reset analytics to null, keep alertLevel ok
    if (!inspecciones.length) {
      return this.prisma.tire.update({
        where:   { id: tireId },
        data: {
          currentCpk:           null,
          currentCpt:           null,
          currentProfundidad:   null,
          cpkTrend:             null,
          projectedKmRemaining: null,
          projectedDateEOL:     null,
          healthScore:          null,
          alertLevel:           TireAlertLevel.ok,
        },
        include: { inspecciones: true, costos: true, eventos: true },
      });
    }

    const latest   = inspecciones[inspecciones.length - 1];
    const pInt     = latest.profundidadInt;
    const pCen     = latest.profundidadCen;
    const pExt     = latest.profundidadExt;
    const minDepth = calcMinDepth(pInt, pCen, pExt);
    const avgDepth = (pInt + pCen + pExt) / 3;

    // CPK trend over last 5 inspections (linear regression slope)
    const last5    = inspecciones.slice(-5);
    const cpkTrend = calcCpkTrend(
      last5.map(i => i.cpk ?? 0).filter(v => v > 0),
    );

    // Composite health score (0–100)
    const healthScore = calcHealthScore(
      tire.profundidadInicial, minDepth, cpkTrend, pInt, pCen, pExt,
    );

    // Alert level from health + legal minimum
    const alertLevel = deriveAlertLevel(healthScore, minDepth);

    // Projected EOL date from last inspection's projected km
    const projectedKm      = latest.kmProyectado ?? 0;
    const currentKm        = tire.kilometrosRecorridos || 0;
    const kmLeft           = Math.max(projectedKm - currentKm, 0);
    const daysLeft         = kmLeft > 0 ? (kmLeft / C.KM_POR_MES) * 30 : 0;
    const projectedDateEOL = daysLeft > 0
      ? new Date(Date.now() + daysLeft * C.MS_POR_DIA)
      : null;

    return this.prisma.tire.update({
      where: { id: tireId },
      data:  {
        currentCpk:           latest.cpk,
        currentCpt:           latest.cpt,
        currentProfundidad:   avgDepth,
        cpkTrend,
        projectedKmRemaining: kmLeft > 0 ? Math.round(kmLeft) : null,
        projectedDateEOL,
        healthScore,
        alertLevel,
        lastInspeccionDate:   latest.fecha,
      },
      include: { inspecciones: true, costos: true, eventos: true },
    });
  }

  // ===========================================================================
  // PRIVATE: BUILD TIRE ANALYSIS
  // Used by analyzeTires() and notification generation.
  // Reads from cached columns when available — avoids recomputing on read path.
  // ===========================================================================

  private buildTireAnalysis(tire: any): TireAnalysis {
    const inspecciones: any[] = tire.inspecciones ?? [];

    if (!inspecciones.length) {
      return {
        id:               tire.id,
        posicion:         tire.posicion,
        profundidadActual: null,
        alertLevel:       TireAlertLevel.watch,
        healthScore:      0,
        recomendaciones:  ['🔴 Inspección requerida: Sin inspecciones registradas.'],
        cpkTrend:         null,
        projectedDateEOL: null,
        desechos:         tire.desechos ?? null,
      };
    }

    const sorted = [...inspecciones].sort(
      (a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime(),
    );
    const latest = sorted[0];
    const pInt   = Number(latest.profundidadInt) || 0;
    const pCen   = Number(latest.profundidadCen) || 0;
    const pExt   = Number(latest.profundidadExt) || 0;

    const profundidadActual = (pInt + pCen + pExt) / 3;
    const minDepth          = calcMinDepth(pInt, pCen, pExt);
    const cpkTrend          = calcCpkTrend(
      sorted.slice(0, 5).map(i => i.cpk ?? 0).filter(Boolean),
    );

    // Prefer cached values — avoids redundant computation on read
    const healthScore = tire.healthScore
      ?? calcHealthScore(tire.profundidadInicial, minDepth, cpkTrend, pInt, pCen, pExt);
    const alertLevel  = tire.alertLevel
      ?? deriveAlertLevel(healthScore, minDepth);

    const maxDelta = Math.max(
      Math.abs(pInt - pCen),
      Math.abs(pCen - pExt),
      Math.abs(pInt - pExt),
    );
    const cpk = latest.cpk ?? 0;

    let recomendacion: string;
    if (minDepth <= C.LIMITE_LEGAL_MM) {
      recomendacion = '🔴 Cambio inmediato: Desgaste crítico. Reemplazo urgente.';
    } else if (maxDelta > 3) {
      recomendacion = '🟡 Desgaste irregular: Diferencias entre zonas. Revisar alineación o presión.';
    } else if (cpk > 0 && cpk < 5) {
      recomendacion = '🔴 CPK muy bajo: Alto costo por kilómetro. Evaluar desempeño.';
    } else if (cpkTrend !== null && cpkTrend > 0.1) {
      recomendacion = '🟡 CPK en aumento: La eficiencia de la llanta está degradándose.';
    } else if (profundidadActual <= 4) {
      recomendacion = '🟡 Revisión frecuente: Profundidad bajando. Monitorear.';
    } else {
      recomendacion = '🟢 Buen estado: Sin hallazgos relevantes.';
    }

    return {
      id:               tire.id,
      posicion:         tire.posicion,
      profundidadActual,
      alertLevel,
      healthScore,
      recomendaciones:  [recomendacion],
      cpkTrend,
      projectedDateEOL: tire.projectedDateEOL ?? null,
      desechos:         tire.desechos ?? null,
    };
  }

  // ===========================================================================
  // PRIVATE: FALLBACK PRICE
  // tire_benchmarks materialized view not yet provisioned.
  // When created via pgAdmin / psql, replace this body with the two-level
  // raw SQL lookup (exact match → brand average → constant).
  // ===========================================================================

  private async fetchFallbackPrice(
    _marca: string,
    _diseno: string,
    _dimension: string,
  ): Promise<number> {
    return C.FALLBACK_TIRE_PRICE;
  }

  // ===========================================================================
  // PRIVATE: SUM COSTS FOR A TIRE (aggregate query — no full load needed)
  // ===========================================================================

  private async sumCostoById(tireId: string): Promise<number> {
    const result = await this.prisma.tireCosto.aggregate({
      where: { tireId },
      _sum:  { valor: true },
    });
    return result._sum.valor ?? 0;
  }
}