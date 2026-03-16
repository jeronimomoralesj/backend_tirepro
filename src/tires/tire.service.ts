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
import {
  EjeType,
  TireAlertLevel,
  TireEventType,
  VidaValue,
  MotivoFinVida,
  InspeccionSource,
  Prisma,
} from '@prisma/client';
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
  // Pressure thresholds
  PRESSURE_UNDER_WARN_PSI:     10,
  PRESSURE_UNDER_CRIT_PSI:     20,
  PRESSURE_HEALTH_PENALTY_PER_5PSI: 4,
  PRESSURE_MAX_HEALTH_PENALTY: 20,
} as const;

// Ordered vida sequence — used for forward-only enforcement
const VIDA_SEQUENCE: VidaValue[] = [
  VidaValue.nueva,
  VidaValue.reencauche1,
  VidaValue.reencauche2,
  VidaValue.reencauche3,
  VidaValue.fin,
];

const VALID_VIDA_SET = new Set<string>(VIDA_SEQUENCE);

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

function isVidaValue(s: string | null | undefined): s is VidaValue {
  return !!s && VALID_VIDA_SET.has(s);
}

/**
 * Core CPK / CPT calculation — single source of truth for all write paths.
 *
 * IMPORTANT: `cost` and `km` must be scoped to the current vida phase only.
 * Use `resolveVidaCostAndKm()` to derive them before calling this function.
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

// =============================================================================
// NEW: Per-vida cost and km helpers
// =============================================================================

/**
 * Returns the date at which a given vida phase began for a tire,
 * based on its TireEvento history.
 *
 * Falls back to `installationDate` when no matching evento exists
 * (e.g. for tires uploaded before the vida-transition eventos were tracked).
 */
function resolveVidaStartDate(
  eventos: { fecha: Date | string; notas?: string | null }[],
  vida: VidaValue,
  installationDate: Date,
): Date {
  const evt = [...eventos]
    .filter(e => e.notas === vida)
    .sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime())
    .at(0);
  return evt ? new Date(evt.fecha) : installationDate;
}

/**
 * Given a tire's full cost list and the start date of the current vida phase,
 * returns only the costs that belong to this vida phase.
 *
 * A cost belongs to the current vida if its fecha >= vidaStartDate.
 */
function costsForVida(
  costos: { valor: number; fecha: Date | string }[],
  vidaStartDate: Date,
): { valor: number; fecha: Date | string }[] {
  return costos.filter(c => new Date(c.fecha) >= vidaStartDate);
}

/**
 * Returns { costForVida, kmForVida } scoped to the current vida phase.
 *
 * kmForVida  = current accumulated tire km  MINUS  km at the start of this vida.
 *              The km at vida start is taken from the first inspection of this vida
 *              (kilometrosEstimados), falling back to 0 when no prior inspection exists.
 *
 * costForVida = sum of TireCosto entries dated on or after vidaStartDate.
 *               If no cost exists in the vida window we fall back to the single
 *               most-recent cost (covers tires that had their cost recorded once at
 *               installation and never again).
 */
function resolveVidaCostAndKm(params: {
  costos:               { valor: number; fecha: Date | string }[];
  inspecciones:         { fecha: Date | string; kilometrosEstimados?: number | null }[];
  eventos:              { fecha: Date | string; notas?: string | null }[];
  vidaActual:           VidaValue;
  currentKm:            number;  // tire.kilometrosRecorridos at the moment of the write
  installationDate:     Date;
}): { costForVida: number; kmForVida: number } {
  const { costos, inspecciones, eventos, vidaActual, currentKm, installationDate } = params;

  const vidaStart = resolveVidaStartDate(eventos, vidaActual, installationDate);

  // ── Cost for this vida ───────────────────────────────────────────────────
  const vidaCostos = costsForVida(costos, vidaStart);
  let costForVida: number;

  if (vidaCostos.length > 0) {
    costForVida = vidaCostos.reduce((s, c) => s + c.valor, 0);
  } else {
    // Fallback: use the most recent cost entry (tire registered with a single cost)
    const sorted = [...costos].sort(
      (a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime(),
    );
    costForVida = sorted.at(0)?.valor ?? 0;
  }

  // ── KM for this vida ─────────────────────────────────────────────────────
  // Find the km value at the moment this vida started (first inspection of this vida).
  const vidaInsps = inspecciones
    .filter(i => new Date(i.fecha) >= vidaStart)
    .sort((a, b) => new Date(a.fecha).getTime() - new Date(b.fecha).getTime());

  // km recorded by the first inspection of this vida (= km at vida start)
  const kmAtVidaStart = vidaInsps.at(0)?.kilometrosEstimados ?? 0;

  // km accumulated within this vida = current total minus vida-start km
  const kmForVida = Math.max(currentKm - kmAtVidaStart, 0);

  return { costForVida, kmForVida };
}

/**
 * Health score: 0–100 composite.
 * 50% tread remaining, 30% CPK trend, 20% wear irregularity.
 * Optional pressure penalty applied on top (max -20 pts).
 */
function calcHealthScore(
  profundidadInicial: number,
  minDepth: number,
  cpkTrend: number | null,
  pInt: number,
  pCen: number,
  pExt: number,
  presionPsi?: number | null,
  presionRecomendadaPsi?: number | null,
): number {
  const usable     = Math.max(profundidadInicial - C.LIMITE_LEGAL_MM, 1);
  const remaining  = Math.max(minDepth - C.LIMITE_LEGAL_MM, 0);
  const depthScore = Math.min((remaining / usable) * 100, 100);

  const trendRaw   = cpkTrend !== null ? cpkTrend : 0;
  const trendScore = Math.min(Math.max(50 - trendRaw * 100, 0), 100);

  const maxDelta   = Math.max(
    Math.abs(pInt - pCen),
    Math.abs(pCen - pExt),
    Math.abs(pInt - pExt),
  );
  const irregScore = Math.max(100 - maxDelta * 15, 0);

  let base = Math.round(depthScore * 0.5 + trendScore * 0.3 + irregScore * 0.2);

  if (presionPsi != null && presionRecomendadaPsi != null) {
    const deficit = presionRecomendadaPsi - presionPsi;
    if (deficit > 0) {
      const penalty = Math.min(
        Math.floor(deficit / 5) * C.PRESSURE_HEALTH_PENALTY_PER_5PSI,
        C.PRESSURE_MAX_HEALTH_PENALTY,
      );
      base = Math.max(base - penalty, 0);
    }
  }

  return base;
}

/**
 * Linear regression slope over the last N CPK values.
 * Negative = improving, positive = degrading.
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

function resolvePresionRecomendada(
  vehicle: any,
  posicion: number,
): number | null {
  if (!vehicle?.presionesRecomendadas) return null;
  const configs = Array.isArray(vehicle.presionesRecomendadas)
    ? vehicle.presionesRecomendadas as { posicion: number; presionRecomendadaPsi: number }[]
    : [];
  return configs.find(c => c.posicion === posicion)?.presionRecomendadaPsi ?? null;
}

function buildVidaSnapshotPayload(params: {
  tire:         any;
  vida:         VidaValue;
  vidaInsps:    any[];
  vidaCostos:   any[];
  fechaInicio:  Date;
  fechaFin:     Date;
  bandaNombre?: string;
  bandaMarca?:  string;
  proveedor?:   string;
  motivoFin?:   MotivoFinVida;
  notasRetiro?: string;
  desechoData?: {
    causales:             string;
    milimetrosDesechados: number;
    imageUrls?:           string[];
  };
}) {
  const {
    tire, vida, vidaInsps, vidaCostos,
    fechaInicio, fechaFin,
    bandaNombre, bandaMarca, proveedor,
    motivoFin, notasRetiro, desechoData,
  } = params;

  const firstInsp = vidaInsps.at(0);
  const lastInsp  = vidaInsps.at(-1);

  const diasTotales  = Math.max(
    Math.floor((fechaFin.getTime() - fechaInicio.getTime()) / C.MS_POR_DIA),
    0,
  );
  const mesesTotales = diasTotales / 30;
  const kmTotales    = lastInsp?.kmEfectivos ?? lastInsp?.kilometrosEstimados ?? 0;

  const profundidadInicial = firstInsp
    ? (firstInsp.profundidadInt + firstInsp.profundidadCen + firstInsp.profundidadExt) / 3
    : tire.profundidadInicial;

  const profIntFinal = lastInsp?.profundidadInt ?? null;
  const profCenFinal = lastInsp?.profundidadCen ?? null;
  const profExtFinal = lastInsp?.profundidadExt ?? null;
  const profundidadFinal = lastInsp
    ? (lastInsp.profundidadInt + lastInsp.profundidadCen + lastInsp.profundidadExt) / 3
    : 0;

  const mmDesgastados = Math.max(profundidadInicial - profundidadFinal, 0);

  const desgasteIrregular = lastInsp
    ? Math.max(
        Math.abs(lastInsp.profundidadInt - lastInsp.profundidadCen),
        Math.abs(lastInsp.profundidadCen - lastInsp.profundidadExt),
        Math.abs(lastInsp.profundidadInt - lastInsp.profundidadExt),
      ) > 3
    : false;

  const costoTotal   = vidaCostos.reduce((s: number, c: any) => s + c.valor, 0);
  const costoInicial = vidaCostos.at(0)?.valor ?? 0;

  const cpkData = vidaInsps.filter((i: any) => (i.cpk ?? 0) > 0).map((i: any) => i.cpk as number);
  const cpkAvg  = cpkData.length ? cpkData.reduce((a: number, b: number) => a + b, 0) / cpkData.length : null;
  const cpkMin  = cpkData.length ? Math.min(...cpkData) : null;
  const cpkMax  = cpkData.length ? Math.max(...cpkData) : null;

  const presionData = vidaInsps.filter((i: any) => i.presionPsi != null).map((i: any) => i.presionPsi as number);
  const presionAvg  = presionData.length ? presionData.reduce((a: number, b: number) => a + b, 0) / presionData.length : null;
  const presionMin  = presionData.length ? Math.min(...presionData) : null;
  const presionMax  = presionData.length ? Math.max(...presionData) : null;

  let desechoRemanente: number | null = null;
  const desechoMilimetros = desechoData?.milimetrosDesechados ?? null;
  if (desechoMilimetros != null && lastInsp?.cpk && kmTotales > 0 && mmDesgastados > 0) {
    const kmPerMm      = kmTotales / mmDesgastados;
    desechoRemanente   = parseFloat((lastInsp.cpk * kmPerMm * desechoMilimetros).toFixed(2));
  }

  return {
    vida,
    marca:     tire.marca,
    diseno:    bandaNombre ?? tire.diseno,
    dimension: tire.dimension,
    eje:       tire.eje,
    posicion:  tire.posicion ?? null,
    bandaNombre:  bandaNombre  ?? null,
    bandaMarca:   bandaMarca   ?? null,
    proveedor:    proveedor    ?? null,
    costoInicial,
    costoTotal,
    fechaInicio,
    fechaFin,
    diasTotales,
    mesesTotales,
    profundidadInicial,
    profundidadFinal,
    mmDesgastados,
    mmDesgastadosPorMes:    mesesTotales > 0 ? mmDesgastados / mesesTotales : null,
    mmDesgastadosPor1000km: kmTotales    > 0 ? (mmDesgastados / kmTotales) * 1000 : null,
    profundidadIntFinal: profIntFinal,
    profundidadCenFinal: profCenFinal,
    profundidadExtFinal: profExtFinal,
    desgasteIrregular,
    kmTotales,
    kmProyectadoFinal: lastInsp?.kmProyectado ?? null,
    cpkFinal:           lastInsp?.cpk           ?? null,
    cptFinal:           lastInsp?.cpt           ?? null,
    cpkProyectadoFinal: lastInsp?.cpkProyectado ?? null,
    cptProyectadoFinal: lastInsp?.cptProyectado ?? null,
    cpkMin,
    cpkMax,
    cpkAvg,
    presionAvgPsi:          presionAvg,
    presionMinPsi:          presionMin,
    presionMaxPsi:          presionMax,
    inspeccionesConPresion: presionData.length,
    healthScoreAtEnd:  tire.healthScore ?? null,
    alertLevelAtEnd:   tire.alertLevel  ?? null,
    totalInspecciones: vidaInsps.length,
    firstInspeccionId: firstInsp?.id ?? null,
    lastInspeccionId:  lastInsp?.id  ?? null,
    motivoFin:    motivoFin   ?? null,
    notasRetiro:  notasRetiro ?? null,
    desechoCausales:   desechoData?.causales          ?? null,
    desechoMilimetros: desechoMilimetros,
    desechoRemanente,
    desechoImageUrls:  desechoData?.imageUrls          ?? [],
    dataSource: 'live',
  };
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
  'presion psi':          'presion_psi',
  'presión psi':          'presion_psi',
  'presion':              'presion_psi',
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
  'tipo llanta':         'tipollanta',
  'tipo de llanta':      'tipollanta',
  'fecha ult ins':       'fecha_inspeccion',
  'fecha ult. ins':      'fecha_inspeccion',
  'presion psi':         'presion_psi',
  'presión psi':         'presion_psi',
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

  // ── Cache key helpers ─────────────────────────────────────────────────────

  private tireKey(companyId: string) {
    return `tires:${companyId}`;
  }

  private vehicleKey(vehicleId: string) {
    return `tires:vehicle:${vehicleId}`;
  }

  private benchmarkKey(marca: string, diseno: string, dimension: string) {
    return `benchmark:${marca}:${diseno}:${dimension}`;
  }

  private static readonly TTL_COMPANY    = 60 * 60 * 1000;
  private static readonly TTL_VEHICLE    = 10 * 60 * 1000;
  private static readonly TTL_BENCHMARK  = 24 * 60 * 60 * 1000;

  private async invalidateCompanyCache(companyId: string) {
    await this.cache.del(this.tireKey(companyId));
  }

  private async invalidateVehicleCache(vehicleId: string) {
    await this.cache.del(this.vehicleKey(vehicleId));
  }

  private resolveCurrentVida(eventos: any[]): VidaValue {
    const vidaEvts = eventos
      .filter(e => isVidaValue(e.notas))
      .sort((a, b) => new Date(a.fecha).getTime() - new Date(b.fecha).getTime());
    const last = vidaEvts.at(-1);
    return isVidaValue(last?.notas) ? (last!.notas as VidaValue) : VidaValue.nueva;
  }

  private resolveVidaStartDate(eventos: any[], vida: VidaValue, fallback: Date): Date {
    return resolveVidaStartDate(eventos, vida, fallback);
  }

  private async fetchFallbackPrice(
    marca: string,
    diseno: string,
    dimension: string,
  ): Promise<number> {
    const cacheKey = this.benchmarkKey(marca, diseno, dimension);
    const cached   = await this.cache.get<number>(cacheKey);
    if (cached != null) return cached;

    try {
      const benchmark = await this.prisma.tireBenchmark.findUnique({
        where:  { marca_diseno_dimension: { marca, diseno, dimension } },
        select: { precioPromedio: true },
      });
      const price = benchmark?.precioPromedio ?? C.FALLBACK_TIRE_PRICE;
      await this.cache.set(cacheKey, price, TireService.TTL_BENCHMARK);
      return price;
    } catch (_) {
      await this.cache.set(cacheKey, C.FALLBACK_TIRE_PRICE, TireService.TTL_BENCHMARK);
      return C.FALLBACK_TIRE_PRICE;
    }
  }

  private async sumCostoById(tireId: string): Promise<number> {
    const result = await this.prisma.tireCosto.aggregate({
      where: { tireId },
      _sum:  { valor: true },
    });
    return result._sum.valor ?? 0;
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

    const [company, vehicle] = await Promise.all([
      this.prisma.company.findUnique({ where: { id: companyId }, select: { id: true } }),
      vehicleId
        ? this.prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { id: true } })
        : Promise.resolve(null),
    ]);

    if (!company)              throw new BadRequestException('Invalid companyId');
    if (vehicleId && !vehicle) throw new BadRequestException('Invalid vehicleId');

    if (placa?.trim()) {
      const normalizedPlaca = placa.trim().toLowerCase();
      const existing = await this.prisma.tire.findFirst({
        where: { placa: normalizedPlaca, companyId },
        include: {
          vehicle:      { select: { placa: true, tipovhc: true } },
          inspecciones: { orderBy: { fecha: 'desc' }, take: 1 },
        },
      });

      if (existing) {
        return {
          duplicate: true,
          existingTire: {
            id:             existing.id,
            placa:          existing.placa,
            marca:          existing.marca,
            diseno:         existing.diseno,
            dimension:      existing.dimension,
            eje:            existing.eje,
            posicion:       existing.posicion,
            vehicle:        existing.vehicle
              ? { placa: existing.vehicle.placa, tipovhc: existing.vehicle.tipovhc }
              : null,
            suggestedPlaca: normalizedPlaca + '*',
          },
        };
      }
    }

    const finalPlaca  = placa?.trim() ? placa.trim().toLowerCase() : generateTireId().toLowerCase();
    const instalacion = fechaInstalacion ? new Date(fechaInstalacion) : new Date();

    const incomingVidaEvt = Array.isArray(eventos)
      ? [...eventos]
          .filter(e => isVidaValue(e.notas))
          .sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime())
          .at(0)
      : null;
    const initialVida: VidaValue = isVidaValue(incomingVidaEvt?.notas)
      ? (incomingVidaEvt!.notas as VidaValue)
      : VidaValue.nueva;

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
        vidaActual:           initialVida,
        totalVidas:           0,
        primeraVida:          toJson(Array.isArray(primeraVida) ? primeraVida : []),
        desechos:             desechos ?? null,
      },
    });

    await Promise.all([
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
              vidaAlMomento:       initialVida,
              source:              InspeccionSource.manual,
            })),
          })
        : Promise.resolve(),

      Array.isArray(eventos) && eventos.length
        ? this.prisma.tireEvento.createMany({
            data: eventos.map((e: any) => ({
              tireId:   newTire.id,
              tipo:     (e.tipo as TireEventType) ?? TireEventType.montaje,
              fecha:    new Date(e.fecha),
              notas:    e.notas ?? null,
              metadata: e.metadata ? toJson(e.metadata) : Prisma.JsonNull,
            })),
          })
        : Promise.resolve(),

      Array.isArray(costo) && costo.length
        ? this.prisma.tireCosto.createMany({
            data: costo.map((c: any) => ({
              tireId:   newTire.id,
              valor:    c.valor,
              fecha:    new Date(c.fecha),
              concepto: c.concepto ?? 'compra_nueva',
            })),
          })
        : Promise.resolve(),
    ]);

    await this.invalidateCompanyCache(companyId);
    if (vehicleId) await this.invalidateVehicleCache(vehicleId);
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
    const tireIdsToRefresh = new Set<string>();

    let lastTipoVHC = '';
    let lastPlaca   = '';

    for (let i = 0; i < rows.length; i++) {
      const row    = rows[i];
      const rowNum = i + 2;

      try {
        if (fmtB) {
          const tv = get(row, 'tipovhc')?.trim();
          const pl = get(row, 'placa_vehiculo')?.trim();
          if (tv) lastTipoVHC = tv;
          if (pl) lastPlaca   = pl;
        }

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

        const profInt  = safeFloat(get(row, 'profundidad_int'));
        const profCen  = safeFloat(get(row, 'profundidad_cen'));
        const profExt  = safeFloat(get(row, 'profundidad_ext'));
        const hasInsp  = profInt > 0 || profCen > 0 || profExt > 0;
        const minDepth = hasInsp ? calcMinDepth(profInt, profCen, profExt) : 0;

        const presionRaw = safeFloat(get(row, 'presion_psi'), 0);
        const presionPsi = presionRaw > 0 ? presionRaw : null;

        let profundidadInicial = safeFloat(get(row, 'profundidad_inicial'));
        if (profundidadInicial <= 0) {
          const maxObs = Math.max(profInt, profCen, profExt);
          profundidadInicial = maxObs > 0
            ? (maxObs > C.DEFAULT_PROFUNDIDAD_INICIAL ? maxObs + 1 : C.DEFAULT_PROFUNDIDAD_INICIAL)
            : C.DEFAULT_PROFUNDIDAD_INICIAL;
          warnings.push(`Row ${rowNum}: profundidadInicial inferred as ${profundidadInicial}mm`);
        }

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
            await this.prisma.vehicle.update({ where: { id: vehicle.id }, data: { tipovhc } });
          }
        }

        const costoRaw = get(row, 'costo');
        let costoCell  = parseCurrency(costoRaw);
        if (costoCell <= 0) {
          costoCell = await this.fetchFallbackPrice(marca, diseno, dimension);
          warnings.push(`Row ${rowNum}: Cost fallback used — $${costoCell}`);
        }

        const fechaInstalacion = new Date(Date.now());
        const rawFechaInsp     = get(row, 'fecha_inspeccion')?.trim();
        const fechaInspeccion  = rawFechaInsp ? new Date(rawFechaInsp) : fechaInstalacion;
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

        const presionRecomendada = vehicle
          ? resolvePresionRecomendada(vehicle, posicion)
          : null;
        const presionDelta = (presionPsi != null && presionRecomendada != null)
          ? presionPsi - presionRecomendada
          : null;

        const vidaAlMomento: VidaValue = isVidaValue(vidaValor)
          ? (vidaValor as VidaValue)
          : VidaValue.nueva;

        let existing: any = null;
        if (!needsIdGeneration(rawId)) {
          existing = await this.prisma.tire.findFirst({ where: { placa: tirePlaca } });
        }
        if (!existing && vehicle && posicion > 0) {
          existing = await this.prisma.tire.findFirst({
            where: { vehicleId: vehicle.id, posicion },
          });
        }

        // ── Branch A: existing tire — append inspection ────────────────────────
        if (existing) {
          if (hasInsp) {
            // -----------------------------------------------------------------
            // FIX: Use only the cost and km that belong to the current vida
            // phase, not the tire's full accumulated totals.
            // -----------------------------------------------------------------
            const existingWithRelations = await this.prisma.tire.findUnique({
              where:   { id: existing.id },
              include: {
                costos:       { orderBy: { fecha: 'asc' } },
                inspecciones: { orderBy: { fecha: 'asc' }, select: { fecha: true, kilometrosEstimados: true } },
                eventos:      { orderBy: { fecha: 'asc' }, select: { fecha: true, notas: true } },
              },
            });

            const vidaActual = existingWithRelations?.vidaActual ?? VidaValue.nueva;
            const installDate = existingWithRelations?.fechaInstalacion ?? new Date();

            const { costForVida, kmForVida } = resolveVidaCostAndKm({
              costos:           existingWithRelations?.costos       ?? [],
              inspecciones:     existingWithRelations?.inspecciones ?? [],
              eventos:          existingWithRelations?.eventos      ?? [],
              vidaActual,
              currentKm:        kmEstimados,
              installationDate: installDate,
            });

            const metrics = calcCpkMetrics(
              costForVida,
              kmForVida,
              mesesEnUso,
              existing.profundidadInicial || profundidadInicial,
              minDepth,
            );

            await this.prisma.inspeccion.create({
              data: {
                tireId:               existing.id,
                fecha:                fechaInstalacion,
                profundidadInt:       profInt,
                profundidadCen:       profCen,
                profundidadExt:       profExt,
                cpk:                  metrics.cpk,
                cpkProyectado:        metrics.cpkProyectado,
                cpt:                  metrics.cpt,
                cptProyectado:        metrics.cptProyectado,
                diasEnUso,
                mesesEnUso,
                kilometrosEstimados:  kmEstimados,
                kmActualVehiculo:     kmVehiculo || 0,
                kmEfectivos:          kmEstimados,
                kmProyectado:         metrics.projectedKm,
                imageUrl:             get(row, 'imageurl') || null,
                presionPsi,
                presionRecomendadaPsi: presionRecomendada,
                presionDelta,
                vidaAlMomento:        vidaActual,
                source:               InspeccionSource.bulk_upload,
              },
            });

            await this.prisma.tire.update({
              where: { id: existing.id },
              data:  { kilometrosRecorridos: kmEstimados, diasAcumulados: diasEnUso },
            });

            tireIdsToRefresh.add(existing.id);
          }

        // ── Branch B: new tire ─────────────────────────────────────────────────
        } else {
          let finalTirePlaca = tirePlaca;
          const alreadyExists = await this.prisma.tire.findFirst({
            where: { placa: tirePlaca, companyId },
          });
          if (alreadyExists) {
            finalTirePlaca = tirePlaca + '*';
            warnings.push(`Row ${rowNum}: ID "${tirePlaca}" duplicado — guardado como "${finalTirePlaca}"`);
          }

          const newTire = await this.prisma.tire.create({
            data: {
              placa:                finalTirePlaca,
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
              vidaActual:           vidaAlMomento,
              totalVidas:           0,
              primeraVida:          toJson([]),
            },
          });

          if (costoCell > 0) {
            await this.prisma.tireCosto.create({
              data: { tireId: newTire.id, valor: costoCell, fecha: now, concepto: 'compra_nueva' },
            });
          }

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

          if (hasInsp) {
            // For a brand-new tire, the full cost IS the vida cost — no prior vidas exist.
            const metrics = calcCpkMetrics(
              costoCell, kmEstimados, mesesEnUso, profundidadInicial, minDepth,
            );

            await this.prisma.inspeccion.create({
              data: {
                tireId:               newTire.id,
                fecha:                fechaInspeccion,
                profundidadInt:       profInt,
                profundidadCen:       profCen,
                profundidadExt:       profExt,
                cpk:                  metrics.cpk,
                cpkProyectado:        metrics.cpkProyectado,
                cpt:                  metrics.cpt,
                cptProyectado:        metrics.cptProyectado,
                diasEnUso,
                mesesEnUso,
                kilometrosEstimados:  kmEstimados,
                kmActualVehiculo:     kmVehiculo || 0,
                kmEfectivos:          kmEstimados,
                kmProyectado:         metrics.projectedKm,
                imageUrl:             get(row, 'imageurl') || null,
                presionPsi,
                presionRecomendadaPsi: presionRecomendada,
                presionDelta,
                vidaAlMomento,
                source:               InspeccionSource.bulk_upload,
              },
            });
          }

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

          tireIdsToRefresh.add(newTire.id);
        }

      } catch (err: any) {
        this.logger.error(`Row ${rowNum} failed: ${err.message}`, err.stack);
        errors.push(`Row ${rowNum}: Unexpected error — ${err.message}`);
      }
    }

    for (const tireId of tireIdsToRefresh) {
      try {
        await this.refreshTireAnalyticsCache(tireId);
      } catch (e: any) {
        this.logger.warn(`Analytics refresh failed for tire ${tireId}: ${e.message}`);
      }
    }

    const vehicleIds = new Set<string>();
    for (const tireId of tireIdsToRefresh) {
      try {
        const t = await this.prisma.tire.findUnique({
          where:  { id: tireId },
          select: { vehicleId: true },
        });
        if (t?.vehicleId) vehicleIds.add(t.vehicleId);
      } catch (_) {}
    }
    await this.invalidateCompanyCache(companyId);
    for (const vid of vehicleIds) {
      await this.invalidateVehicleCache(vid);
      await this.cache.del(`analysis:${vid}`);
    }
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
        costos:       true,
        eventos:      true,
      },
    });

    await this.cache.set(this.tireKey(companyId), tires, TireService.TTL_COMPANY);
    return tires;
  }

  async findTiresByVehicle(vehicleId: string) {
    if (!vehicleId) throw new BadRequestException('vehicleId is required');

    const cacheKey = this.vehicleKey(vehicleId);
    const cached   = await this.cache.get(cacheKey);
    if (cached) return cached;

    const tires = await this.prisma.tire.findMany({
      where:   { vehicleId },
      include: {
        inspecciones: { orderBy: { fecha: 'desc' } },
        costos:       { orderBy: { fecha: 'asc'  } },
        eventos:      { orderBy: { fecha: 'asc'  } },
      },
    });

    await this.cache.set(cacheKey, tires, TireService.TTL_VEHICLE);
    return tires;
  }

  async findAllTires() {
    const cacheKey = 'tires:all';
    const cached   = await this.cache.get(cacheKey);
    if (cached) return cached;

    const tires = await this.prisma.tire.findMany({
      include: { inspecciones: { orderBy: { fecha: 'desc' }, take: 1 } },
    });

    await this.cache.set(cacheKey, tires, TireService.TTL_VEHICLE);
    return tires;
  }

  // ===========================================================================
  // UPDATE INSPECTION
  // ===========================================================================

  async updateInspection(tireId: string, dto: UpdateInspectionDto) {
    if (dto.profundidadInt === 0 && dto.profundidadCen === 0 && dto.profundidadExt === 0) {
      return this.prisma.tire.findUnique({ where: { id: tireId } });
    }

    const tire = await this.prisma.tire.findUnique({
      where:   { id: tireId },
      include: {
        costos:       { orderBy: { fecha: 'asc'  } },
        inspecciones: { orderBy: { fecha: 'asc'  } },  // asc — needed for vida-start km lookup
        eventos:      { orderBy: { fecha: 'asc'  } },
        vehicle:      true,
      },
    });
    if (!tire)           throw new NotFoundException('Tire not found');
    if (!tire.vehicleId) throw new BadRequestException('Tire is not associated with a vehicle');

    const vehicle      = tire.vehicle!;
    const newVehicleKm = dto.newKilometraje || 0;
    const odometerSent = newVehicleKm > 0;
    const priorTireKm  = tire.kilometrosRecorridos || 0;

    // ── KM delta ──────────────────────────────────────────────────────────────
    let kilometrosRecorridos: number;
    const kmDelta = dto.kmDelta ?? 0;

    if (kmDelta > 0) {
      kilometrosRecorridos = priorTireKm + kmDelta;
    } else if (odometerSent && tire.inspecciones.length > 0) {
      const lastKnownVehicleKm =
        tire.inspecciones[tire.inspecciones.length - 1].kmActualVehiculo ?? vehicle.kilometrajeActual ?? 0;
      kilometrosRecorridos = priorTireKm + Math.max(newVehicleKm - lastKnownVehicleKm, 0);
    } else {
      kilometrosRecorridos = priorTireKm;
    }

    const now              = new Date();
    const fechaInstalacion = tire.fechaInstalacion ?? now;
    const diasEnUso        = Math.max(
      Math.floor((now.getTime() - new Date(fechaInstalacion).getTime()) / C.MS_POR_DIA),
      1,
    );
    const mesesEnUso = diasEnUso / 30;

    const minDepth    = calcMinDepth(dto.profundidadInt, dto.profundidadCen, dto.profundidadExt);
    const effectiveKm = kilometrosRecorridos > 0
      ? kilometrosRecorridos
      : Math.round(mesesEnUso * C.KM_POR_MES);

    // -------------------------------------------------------------------------
    // FIX: Compute CPK using only the cost and km from the current vida phase.
    // -------------------------------------------------------------------------
    const { costForVida, kmForVida } = resolveVidaCostAndKm({
      costos:           tire.costos,
      inspecciones:     tire.inspecciones,
      eventos:          tire.eventos,
      vidaActual:       tire.vidaActual ?? VidaValue.nueva,
      currentKm:        effectiveKm,
      installationDate: tire.fechaInstalacion ?? now,
    });

    const metrics = calcCpkMetrics(
      costForVida,
      kmForVida,
      mesesEnUso,
      tire.profundidadInicial,
      minDepth,
    );

    // ── Pressure fields ────────────────────────────────────────────────────────
    const presionPsi: number | null = dto.presionPsi ?? null;
    const presionRecomendada =
      dto.presionRecomendadaPsi
      ?? resolvePresionRecomendada(vehicle, tire.posicion)
      ?? null;
    const presionDelta = (presionPsi != null && presionRecomendada != null)
      ? presionPsi - presionRecomendada
      : null;

    const source: InspeccionSource = dto.source ?? InspeccionSource.manual;

    const inspeccionadoPorId:     string | null = dto.inspeccionadoPorId     ?? null;
    const inspeccionadoPorNombre: string | null = dto.inspeccionadoPorNombre ?? null;

    let finalImageUrl = dto.imageUrl ?? null;
    if (dto.imageUrl?.startsWith('data:')) {
      const [header, b64] = dto.imageUrl.split(',');
      const mime = header.match(/data:(image\/\w+);/)?.[1] ?? 'image/jpeg';
      finalImageUrl = await this.s3.uploadInspectionImage(
        Buffer.from(b64, 'base64'), tireId, mime,
      );
    }

    const cvProfundidadInt: number | null = dto.cvProfundidadInt ?? null;
    const cvProfundidadCen: number | null = dto.cvProfundidadCen ?? null;
    const cvProfundidadExt: number | null = dto.cvProfundidadExt ?? null;
    const cvConfidence:     number | null = dto.cvConfidence     ?? null;
    const cvModelVersion:   string | null = dto.cvModelVersion   ?? null;

    await this.prisma.inspeccion.create({
      data: {
        tireId,
        fecha:                 now,
        profundidadInt:        dto.profundidadInt,
        profundidadCen:        dto.profundidadCen,
        profundidadExt:        dto.profundidadExt,
        cpk:                   metrics.cpk,
        cpkProyectado:         metrics.cpkProyectado,
        cpt:                   metrics.cpt,
        cptProyectado:         metrics.cptProyectado,
        diasEnUso,
        mesesEnUso,
        kilometrosEstimados:   kilometrosRecorridos,
        kmActualVehiculo:      odometerSent ? newVehicleKm : (vehicle.kilometrajeActual || 0),
        kmEfectivos:           effectiveKm,
        kmProyectado:          metrics.projectedKm,
        imageUrl:              finalImageUrl,
        presionPsi,
        presionRecomendadaPsi: presionRecomendada,
        presionDelta,
        vidaAlMomento:         tire.vidaActual ?? VidaValue.nueva,
        source,
        inspeccionadoPorId,
        inspeccionadoPorNombre,
        cvProfundidadInt,
        cvProfundidadCen,
        cvProfundidadExt,
        cvConfidence,
        cvModelVersion,
      },
    });

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

    const updatedTire = await this.refreshTireAnalyticsCache(tireId);

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
    if (tire.vehicleId) {
      await this.invalidateVehicleCache(tire.vehicleId);
      await this.cache.del(`analysis:${tire.vehicleId}`);
    }
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
    desechoData?: {
      causales:             string;
      milimetrosDesechados: number;
      imageUrls?:           string[];
    },
    bandaMarca?: string,
    motivoFinOverride?: MotivoFinVida,
    notasRetiro?: string,
  ) {
    if (!newValor) throw new BadRequestException(`El campo 'valor' es obligatorio`);

    const normalizedValor = newValor.toLowerCase() as VidaValue;
    const newIndex        = VIDA_SEQUENCE.indexOf(normalizedValor);
    if (newIndex < 0) throw new BadRequestException(`"${newValor}" no es un valor válido`);

    let parsedProfundidad: number | null = null;
    if (normalizedValor !== VidaValue.fin) {
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
        eventos:      { orderBy: { fecha: 'asc' } },
        inspecciones: { orderBy: { fecha: 'asc' } },
        costos:       { orderBy: { fecha: 'asc' } },
      },
    });
    if (!tire) throw new NotFoundException('Tire not found');

    const currentVida  = tire.vidaActual ?? this.resolveCurrentVida(tire.eventos);
    const currentIndex = VIDA_SEQUENCE.indexOf(currentVida);

    if (newIndex <= currentIndex) {
      throw new BadRequestException(
        `Debe avanzar en la secuencia. Vida actual: "${currentVida}".`,
      );
    }

    const now = new Date();

    const fechaInicioCurrentVida = this.resolveVidaStartDate(
      tire.eventos,
      currentVida,
      tire.fechaInstalacion ?? tire.createdAt,
    );

    const vidaInsps  = tire.inspecciones.filter(
      (i: any) => new Date(i.fecha) >= fechaInicioCurrentVida,
    );
    const vidaCostos = tire.costos.filter(
      (c: any) => new Date(c.fecha) >= fechaInicioCurrentVida,
    );

    let finalDesechoImageUrls: string[] = [];
    if (normalizedValor === VidaValue.fin && desechoData?.imageUrls?.length) {
      finalDesechoImageUrls = await Promise.all(
        desechoData.imageUrls.slice(0, 3).map(async (img, idx) => {
          if (img.startsWith('data:')) {
            const [header, b64] = img.split(',');
            const mime = header.match(/data:(image\/\w+);/)?.[1] ?? 'image/jpeg';
            return this.s3.uploadDesechoImage(Buffer.from(b64, 'base64'), tireId, idx, mime);
          }
          return img;
        }),
      );
    }

    const motivoFin: MotivoFinVida | undefined =
      motivoFinOverride
      ?? (normalizedValor.startsWith('reencauche') ? MotivoFinVida.reencauche :
          normalizedValor === VidaValue.fin        ? MotivoFinVida.desgaste   :
          undefined);

    const snapshotPayload = buildVidaSnapshotPayload({
      tire,
      vida:        currentVida,
      vidaInsps,
      vidaCostos,
      fechaInicio: fechaInicioCurrentVida,
      fechaFin:    now,
      bandaNombre: banda?.trim(),
      bandaMarca:  bandaMarca?.trim(),
      proveedor,
      motivoFin,
      notasRetiro,
      desechoData: normalizedValor === VidaValue.fin && desechoData
        ? { ...desechoData, imageUrls: finalDesechoImageUrls }
        : undefined,
    });

    await this.prisma.tireVidaSnapshot.create({
      data: {
        ...snapshotPayload,
        tireId,
        companyId: tire.companyId,
      },
    });

    // ── Auto-inspection on reencauche vida start ──────────────────────────────
    if (normalizedValor.startsWith('reencauche') && parsedProfundidad !== null) {
      // The new vida starts fresh — only the reencauche cost counts at this point.
      const reencaucheCost = typeof costo === 'number' && costo > 0 ? costo : C.REENCAUCHE_COST;

      const metrics = calcCpkMetrics(
        reencaucheCost,
        0, // km = 0 at the very start of a new vida
        0, // months = 0 at the very start
        parsedProfundidad,
        parsedProfundidad, // no wear yet
      );

      await this.prisma.inspeccion.create({
        data: {
          tireId,
          fecha:               now,
          profundidadInt:      parsedProfundidad,
          profundidadCen:      parsedProfundidad,
          profundidadExt:      parsedProfundidad,
          cpk:                 metrics.cpk,
          cpkProyectado:       metrics.cpkProyectado,
          cpt:                 metrics.cpt,
          cptProyectado:       metrics.cptProyectado,
          diasEnUso:           0,
          mesesEnUso:          0,
          kilometrosEstimados: tire.kilometrosRecorridos || 0,
          kmActualVehiculo:    (tire as any).vehicle?.kilometrajeActual ?? 0,
          kmEfectivos:         0, // km in THIS vida = 0 at start
          kmProyectado:        metrics.projectedKm,
          vidaAlMomento:       normalizedValor,
          source:              InspeccionSource.manual,
        },
      });
    }

    const updateData: Prisma.TireUpdateInput = {
      vidaActual: normalizedValor,
      totalVidas: { increment: 1 },
    };

    if (normalizedValor !== VidaValue.fin && parsedProfundidad !== null) {
      updateData.profundidadInicial = parsedProfundidad;
    }

    if (banda?.trim()) updateData.diseno = banda.trim();

    if (normalizedValor.startsWith('reencauche')) {
      const costoValue = typeof costo === 'number' && costo > 0
        ? costo
        : (tire.costos.at(-1)?.valor ?? C.REENCAUCHE_COST);

      if (costoValue > 0) {
        await this.prisma.tireCosto.create({
          data: { tireId, valor: costoValue, fecha: now, concepto: 'reencauche' },
        });
      }
    }

    await this.prisma.tireEvento.create({
      data: {
        tireId,
        tipo:     TireEventType.reencauche,
        fecha:    now,
        notas:    normalizedValor,
        metadata: toJson({
          vidaValor:  normalizedValor,
          proveedor:  proveedor ?? null,
          banda:      banda      ?? null,
        }),
      },
    });

    if (normalizedValor === VidaValue.reencauche1) {
      const lastInsp   = tire.inspecciones.at(-1);
      const costoVal   = typeof costo === 'number' && costo > 0
        ? costo
        : (tire.costos.at(-1)?.valor ?? 0);

      updateData.primeraVida = toJson([{
        diseno:     banda?.trim() || tire.diseno,
        cpk:        lastInsp?.cpk ?? 0,
        costo:      costoVal,
        kilometros: tire.kilometrosRecorridos || 0,
      }]);
    }

    if (normalizedValor === VidaValue.fin) {
      if (!desechoData?.causales || desechoData.milimetrosDesechados === undefined) {
        throw new BadRequestException('Información de desecho incompleta');
      }

      updateData.vehicle = { disconnect: true };

      updateData.inventoryBucket = { disconnect: true };
      updateData.lastVehicleId      = null;
      updateData.lastVehiclePlaca   = null;
      updateData.lastPosicion       = null;
      updateData.inventoryEnteredAt = null;

      updateData.desechos = toJson({
        causales:             desechoData.causales,
        milimetrosDesechados: desechoData.milimetrosDesechados,
        remanente:            snapshotPayload.desechoRemanente ?? 0,
        fecha:                now.toISOString(),
        imageUrls:            finalDesechoImageUrls,
      });
    }

    const finalTire = await this.prisma.tire.update({
      where:   { id: tireId },
      data:    updateData,
      include: { inspecciones: true, costos: true, eventos: true },
    });

    await this.notificationsService.deleteByTire(tireId);
    await this.invalidateCompanyCache(tire.companyId);
    if (tire.vehicleId) {
      await this.invalidateVehicleCache(tire.vehicleId);
      await this.cache.del(`analysis:${tire.vehicleId}`);
    }
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

    await this.invalidateCompanyCache(vehicle.companyId);
    await this.invalidateVehicleCache(vehicle.id);
    await this.cache.del(`analysis:${vehicle.id}`);
    return { message: 'Positions updated successfully' };
  }

  // ===========================================================================
  // ANALYZE TIRES FOR VEHICLE
  // ===========================================================================

  async analyzeTires(vehiclePlaca: string) {
    const vehicle = await this.prisma.vehicle.findFirst({ where: { placa: vehiclePlaca } });
    if (!vehicle) throw new NotFoundException(`Vehicle ${vehiclePlaca} not found`);

    const cacheKey = `analysis:${vehicle.id}`;
    const cached   = await this.cache.get(cacheKey);
    if (cached) return cached;

    const tires = await this.prisma.tire.findMany({
      where:   { vehicleId: vehicle.id },
      include: {
        inspecciones: { orderBy: { fecha: 'desc' }, take: 5 },
        costos:       true,
      },
    });
    if (!tires.length) throw new NotFoundException(`No tires for vehicle ${vehiclePlaca}`);

    const result = { vehicle, tires: tires.map(t => this.buildTireAnalysis(t)) };
    await this.cache.set(cacheKey, result, TireService.TTL_VEHICLE);
    return result;
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

    const tireForCache = await this.prisma.tire.findUniqueOrThrow({
      where:  { id: tireId },
      select: { companyId: true, vehicleId: true },
    });

    await this.prisma.inspeccion.delete({ where: { id: insp.id } });
    await this.refreshTireAnalyticsCache(tireId);
    await this.invalidateCompanyCache(tireForCache.companyId);
    if (tireForCache.vehicleId) {
      await this.invalidateVehicleCache(tireForCache.vehicleId);
      await this.cache.del(`analysis:${tireForCache.vehicleId}`);
    }
    return { message: 'Inspección eliminada' };
  }

  // ===========================================================================
  // ASSIGN / UNASSIGN TIRES
  // ===========================================================================

  async assignTiresToVehicle(vehiclePlaca: string, tireIds: string[]) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where:  { placa: vehiclePlaca },
      select: { id: true, companyId: true },
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found');

    await this.prisma.tire.updateMany({
      where: { id: { in: tireIds } },
      data:  { vehicleId: vehicle.id },
    });

    await this.invalidateCompanyCache(vehicle.companyId);
    await this.invalidateVehicleCache(vehicle.id);
    return { message: 'Tires assigned successfully', count: tireIds.length };
  }

  async unassignTiresFromVehicle(tireIds: string[]) {
    const tiresBeforeUnassign = await this.prisma.tire.findMany({
      where:   { id: { in: tireIds } },
      select:  { id: true, vehicleId: true, posicion: true, companyId: true,
                vehicle: { select: { placa: true } } },
    });

    const now = new Date();

    await this.prisma.$transaction(
      tiresBeforeUnassign.map((t) =>
        this.prisma.tire.update({
          where: { id: t.id },
          data: {
            vehicleId:          null,
            posicion:           0,
            lastVehicleId:      t.vehicleId   ?? null,
            lastVehiclePlaca:   t.vehicle?.placa ?? null,
            lastPosicion:       t.posicion    ?? 0,
            inventoryEnteredAt: now,
          },
        }),
      ),
    );

    const sample = tiresBeforeUnassign[0];
    if (sample) {
      await this.invalidateCompanyCache(sample.companyId);
      if (sample.vehicleId) {
        await this.invalidateVehicleCache(sample.vehicleId);
        await this.cache.del(`analysis:${sample.vehicleId}`);
      }
    }
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
      const minDepth = calcMinDepth(profundidadInt, profundidadCen, profundidadExt);
      const km       = insp.kilometrosEstimados ?? tire.kilometrosRecorridos ?? 0;
      const metrics  = calcCpkMetrics(costToDate, km, insp.mesesEnUso ?? 1, profInicial, minDepth);

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

    if (dto.costoEdit) {
      const { fecha: costoFecha, newValor } = dto.costoEdit;

      const costRow = await this.prisma.tireCosto.findFirst({
        where:  { tireId, fecha: new Date(costoFecha) },
        select: { id: true },
      });
      if (!costRow) throw new NotFoundException('Cost entry not found');

      await this.prisma.tireCosto.update({
        where: { id: costRow.id },
        data:  { valor: newValor },
      });

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

    if (Object.keys(updateData).length > 0) {
      await this.prisma.tire.update({ where: { id: tireId }, data: updateData });
    }

    await this.invalidateCompanyCache(tire.companyId);
    if (tire.vehicleId) {
      await this.invalidateVehicleCache(tire.vehicleId);
      await this.cache.del(`analysis:${tire.vehicleId}`);
    }
    return this.refreshTireAnalyticsCache(tireId);
  }

  // ===========================================================================
  // ANALYTICS CACHE REFRESH
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

    if (!inspecciones.length) {
      return this.prisma.tire.update({
        where: { id: tireId },
        data:  {
          currentCpk:           null,
          currentCpt:           null,
          currentProfundidad:   null,
          currentPresionPsi:    null,
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

    // -------------------------------------------------------------------------
    // For the CPK trend we use only inspections of the current vida phase.
    // The vidaAlMomento column on Inspeccion lets us filter without joining eventos.
    // -------------------------------------------------------------------------
    const vidaActual        = tire.vidaActual ?? VidaValue.nueva;
    const vidaInspecciones  = inspecciones.filter(i => i.vidaAlMomento === vidaActual);

    const last5    = vidaInspecciones.slice(-5);
    const cpkTrend = calcCpkTrend(
      last5.map(i => i.cpk ?? 0).filter(v => v > 0),
    );

    const healthScore = calcHealthScore(
      tire.profundidadInicial,
      minDepth,
      cpkTrend,
      pInt,
      pCen,
      pExt,
      latest.presionPsi,
      latest.presionRecomendadaPsi,
    );

    const alertLevel = deriveAlertLevel(healthScore, minDepth);

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
        currentPresionPsi:    latest.presionPsi ?? null,
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
  // ===========================================================================

  private buildTireAnalysis(tire: any): TireAnalysis {
    const inspecciones: any[] = tire.inspecciones ?? [];

    if (!inspecciones.length) {
      return {
        id:                tire.id,
        posicion:          tire.posicion,
        profundidadActual: null,
        alertLevel:        TireAlertLevel.watch,
        healthScore:       0,
        recomendaciones:   ['🔴 Inspección requerida: Sin inspecciones registradas.'],
        cpkTrend:          null,
        projectedDateEOL:  null,
        desechos:          tire.desechos ?? null,
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

    // Use only current-vida inspections for the trend
    const vidaActual     = tire.vidaActual ?? VidaValue.nueva;
    const vidaSorted     = sorted.filter(i => i.vidaAlMomento === vidaActual);
    const cpkTrend       = calcCpkTrend(
      vidaSorted.slice(0, 5).map(i => i.cpk ?? 0).filter(Boolean),
    );

    const healthScore = tire.healthScore
      ?? calcHealthScore(
          tire.profundidadInicial, minDepth, cpkTrend, pInt, pCen, pExt,
          latest.presionPsi, latest.presionRecomendadaPsi,
        );
    const alertLevel = tire.alertLevel ?? deriveAlertLevel(healthScore, minDepth);

    const maxDelta = Math.max(
      Math.abs(pInt - pCen),
      Math.abs(pCen - pExt),
      Math.abs(pInt - pExt),
    );
    const cpk = latest.cpk ?? 0;

    const presionDeficit = (latest.presionPsi != null && latest.presionRecomendadaPsi != null)
      ? latest.presionRecomendadaPsi - latest.presionPsi
      : 0;

    let recomendacion: string;
    if (minDepth <= C.LIMITE_LEGAL_MM) {
      recomendacion = '🔴 Cambio inmediato: Desgaste crítico. Reemplazo urgente.';
    } else if (presionDeficit >= C.PRESSURE_UNDER_CRIT_PSI) {
      recomendacion = `🔴 Presión crítica: ${Math.round(presionDeficit)} PSI bajo lo recomendado. Inflar de inmediato.`;
    } else if (presionDeficit >= C.PRESSURE_UNDER_WARN_PSI) {
      recomendacion = `🟡 Baja presión: ${Math.round(presionDeficit)} PSI bajo lo recomendado. Revisar inflado.`;
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
      id:                tire.id,
      posicion:          tire.posicion,
      profundidadActual,
      alertLevel,
      healthScore,
      recomendaciones:   [recomendacion],
      cpkTrend,
      projectedDateEOL:  tire.projectedDateEOL ?? null,
      desechos:          tire.desechos ?? null,
    };
  }
}