import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CreateTireDto } from './dto/create-tire.dto';
import { UpdateInspectionDto } from './dto/update-inspection.dto';
import { uploadFileToS3 } from './s3.service';
import * as XLSX from 'xlsx';
import { VehicleService } from 'src/vehicles/vehicle.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import { MarketDataService } from '../market-data/market-data.service';
import { Prisma } from '@prisma/client';

// ─── Domain constants ─────────────────────────────────────────────────────────
const CONSTANTS = {
  KM_POR_MES: 6_000,
  MS_POR_DIA: 86_400_000,
  PREMIUM_TIRE_EXPECTED_KM: 120_000,
  STANDARD_TIRE_EXPECTED_KM: 80_000,
  SIGNIFICANT_WEAR_MM: 5,
  RECENT_REGISTRATION_DAYS: 30,
  DEFAULT_PROFUNDIDAD_INICIAL: 22,
  REENCAUCHE_COST: 650_000,
  FALLBACK_TIRE_PRICE: 2_200_000,
  MIN_VALID_PRICE: 1_000_000,
  PREMIUM_TIRE_THRESHOLD: 2_100_000,
  LIMITE_LEGAL_MM: 2,
  ID_LENGTH: 8,
  VIDA_SEQUENCE: ['nueva', 'reencauche1', 'reencauche2', 'reencauche3', 'fin'] as const,
} as const;

export interface EditTireDto {
  // Core fields
  marca?: string;
  diseno?: string;
  dimension?: string;
  eje?: string;
  posicion?: number;
  profundidadInicial?: number;
  kilometrosRecorridos?: number;

  // Edit a specific inspection's depth readings
  inspectionEdit?: {
    fecha: string;          // ISO string — identifies which inspection to edit
    profundidadInt: number;
    profundidadCen: number;
    profundidadExt: number;
  };

  // Edit a specific costo entry
  costoEdit?: {
    fecha: string;          // ISO string — identifies which cost entry to edit
    newValor: number;
  };
}

// ─── Strict domain types for Prisma JSON fields ───────────────────────────────
interface VidaEntry        { fecha: string; valor: string }
interface CostoEntry       { fecha: string; valor: number }
interface PriceEntry       { price: number; date: string; source?: string }
interface PrimeraVidaEntry { diseno: string; cpk: number; costo: number; kilometros: number }
interface EventoEntry      { valor: string; fecha: string }
export interface InspectionEntry {
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
}
interface DesechoData {
  causales: string;
  milimetrosDesechados: number;
  remanente: number;
  fecha: string;
}
interface CpkMetrics {
  cpk: number;
  cpt: number;
  cpkProyectado: number;
  cptProyectado: number;
  projectedKm: number;
}

type VidaValue = typeof CONSTANTS.VIDA_SEQUENCE[number];

/**
 * Cast any typed domain array/object to Prisma's InputJsonValue.
 * Prisma's JSON columns require this cast because its generated types
 * use `InputJsonObject` (which requires an index signature) rather than
 * accepting plain interfaces directly.
 */
function toJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

// ─── Pure utility functions ───────────────────────────────────────────────────

function safeParseFloat(value: unknown, fallback = 0): number {
  const n = parseFloat(String(value ?? ''));
  return isNaN(n) ? fallback : n;
}

function safeParseInt(value: unknown, fallback = 0): number {
  const n = parseInt(String(value ?? ''), 10);
  return isNaN(n) ? fallback : n;
}

function parseCurrency(value: string): number {
  if (!value) return 0;
  const cleaned = value.replace(/[$,\s]/g, '').replace(/[^\d.]/g, '');
  const parsed  = parseFloat(cleaned);
  return isNaN(parsed) ? 0 : parsed;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function generateRandomString(length: number): string {
  let result = '';
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const charactersLength = characters.length;
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }
  return result;
}

function generateTireId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
}

function needsIdGeneration(id: string): boolean {
  if (!id || !id.trim()) return true;
  const normalizedId    = normalize(id);
  const invalidPatterns = ['no aplica', 'no visible', 'no space', 'nospace'];
  return invalidPatterns.some(pattern => normalizedId.includes(pattern));
}

function normalizeTipoVHC(tipovhc: string): string {
  if (!tipovhc) return '';
  const normalized = normalize(tipovhc);
  if (normalized === 'trailer')  return 'trailer 3 ejes';
  if (normalized === 'cabezote') return 'cabezote 2 ejes';
  return tipovhc.trim().toLowerCase();
}

/**
 * Core CPK / CPT calculation — single source of truth used in both
 * bulkUploadTires and updateInspection so the formula is never duplicated.
 *
 *   cpk            = totalCost / km traveled so far
 *   cpt            = totalCost / months in use so far
 *   cpkProyectado  = totalCost / projected lifetime km  (wear-rate extrapolation)
 *   cptProyectado  = totalCost / projected lifetime months
 *   projectedKm    = km at which legal tread limit will be reached
 */
function calcCpkMetrics(
  totalCost: number,
  km: number,
  meses: number,
  profundidadInicial: number,
  minDepth: number,
): CpkMetrics {
  const { LIMITE_LEGAL_MM, KM_POR_MES } = CONSTANTS;

  const cpk = km    > 0 ? totalCost / km    : 0;
  const cpt = meses > 0 ? totalCost / meses : 0;

  // Remaining mm above legal limit → remaining km via wear-rate extrapolation
  const mmWorn = profundidadInicial - minDepth;
  let projectedKm = 0;
  if (mmWorn > 0 && km > 0) {
    const kmPerMm  = km / mmWorn;
    const mmLeft   = Math.max(minDepth - LIMITE_LEGAL_MM, 0);
    projectedKm    = km + kmPerMm * mmLeft;
  }

  const projectedMonths = projectedKm / KM_POR_MES;
  const cpkProyectado   = projectedKm     > 0 ? totalCost / projectedKm     : 0;
  const cptProyectado   = projectedMonths > 0 ? totalCost / projectedMonths : 0;

  return { cpk, cpt, cpkProyectado, cptProyectado, projectedKm };
}

function calcMinDepth(int: number, cen: number, ext: number): number {
  return Math.min(int, cen, ext);
}

// ─── Excel header maps ────────────────────────────────────────────────────────

const HEADER_MAP_A: Record<string, string> = {
  'llanta':                'llanta',
  'numero de llanta':      'llanta',
  'id':                    'llanta',
  'placa vehiculo':        'placa_vehiculo',
  'placa':                 'placa_vehiculo',
  'marca':                 'marca',
  'diseno':                'diseno_original',
  'diseño':                'diseno_original',
  'dimension':             'dimension',
  'dimensión':             'dimension',
  'eje':                   'eje',
  'posicion':              'posicion',
  'vida':                  'vida',
  'kilometros llanta':     'kilometros_llanta',
  'kilometraje vehiculo':  'kilometros_vehiculo',
  'profundidad int':       'profundidad_int',
  'profundidad cen':       'profundidad_cen',
  'profundidad ext':       'profundidad_ext',
  'profundidad inicial':   'profundidad_inicial',
  'costo':                 'costo',
  'cost':                  'costo',
  'precio':                'costo',
  'costo furgon':          'costo',
  'fecha instalacion':     'fecha_instalacion',
  'imageurl':              'imageurl',
  'tipovhc':               'tipovhc',
  'tipo de vehiculo':      'tipovhc',
  'tipo vhc':              'tipovhc',
};

const HEADER_MAP_B: Record<string, string> = {
  'tipo de equipo':        'tipovhc',
  'placa':                 'placa_vehiculo',
  'km actual':             'kilometros_vehiculo',
  'pos':                   'posicion',
  '# numero de llanta':   'llanta',
  'numero de llanta':      'llanta',
  'diseño':                'diseno_original',
  'diseno':                'diseno_original',
  'marca':                 'marca',
  'marca band':            'marca_banda',
  'banda':                 'banda_name',
  'tipo llanta':           'eje',
  'dimensión':             'dimension',
  'dimension':             'dimension',
  'prf int':               'profundidad_int',
  'pro cent':              'profundidad_cen',
  'pro ext':               'profundidad_ext',
  'profundidad inicial':   'profundidad_inicial',
};

function isFormatBDetect(rows: Record<string, string>[]): boolean {
  if (rows.length === 0) return false;
  return Object.keys(rows[0]).some(k =>
    k.toLowerCase().includes('numero de llanta') ||
    k.toLowerCase().includes('tipo de equipo'),
  );
}

function getCell(
  row: Record<string, string>,
  header: string,
  headerMap: Record<string, string>,
): string {
  const normalized = headerMap[normalize(header)] ?? normalize(header);
  const key = Object.keys(row).find(
    k => headerMap[normalize(k)] === normalized || normalize(k) === normalized,
  );
  return key ? String(row[key] ?? '') : '';
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class TireService {
  private readonly logger = new Logger(TireService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vehicleService: VehicleService,
    private readonly notificationsService: NotificationsService,
    private readonly marketDataService: MarketDataService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // CREATE SINGLE TIRE
  // ═══════════════════════════════════════════════════════════════════════════
  async createTire(createTireDto: CreateTireDto) {
    const {
      placa,
      marca,
      diseno,
      profundidadInicial,
      dimension,
      eje,
      vida,
      costo,
      inspecciones,
      primeraVida,
      kilometrosRecorridos,
      eventos,
      companyId,
      vehicleId,
      posicion,
      desechos,
      fechaInstalacion,
    } = createTireDto;

    // ── Validate FK references in parallel ──────────────────────────────────
    const [company, vehicle] = await Promise.all([
      this.prisma.company.findUnique({ where: { id: companyId } }),
      vehicleId
        ? this.prisma.vehicle.findUnique({ where: { id: vehicleId } })
        : Promise.resolve(null),
    ]);

    if (!company) throw new BadRequestException('Invalid companyId provided');
    if (vehicleId && !vehicle) throw new BadRequestException('Invalid vehicleId provided');

    const finalPlaca =
      placa && placa.trim() !== ''
        ? placa.trim().toLowerCase()
        : generateRandomString(CONSTANTS.ID_LENGTH);

    const { canonicalBrand, canonicalDiseno, canonicalDimension } =
      await this.marketDataService.syncTireWithMarketData(marca, diseno ?? '', dimension ?? '');

    const fechaInstalacionFinal = fechaInstalacion ? new Date(fechaInstalacion) : new Date();

    // ── Atomic creation + counter increments ────────────────────────────────
    const [newTire] = await this.prisma.$transaction([
      (this.prisma.tire.create as any)({
        data: {
          placa: finalPlaca,
          marca: canonicalBrand,
          diseno: canonicalDiseno,
          profundidadInicial,
          dimension: canonicalDimension,
          eje,
          posicion,
          vida:                 Array.isArray(vida)         ? vida         : [],
          costo:                Array.isArray(costo)        ? costo        : [],
          inspecciones:         Array.isArray(inspecciones) ? inspecciones : [],
          primeraVida:          Array.isArray(primeraVida)  ? primeraVida  : [],
          kilometrosRecorridos: kilometrosRecorridos ?? 0,
          eventos:              Array.isArray(eventos)      ? eventos      : [],
          companyId,
          vehicleId:            vehicleId ?? null,
          fechaInstalacion:     fechaInstalacionFinal,
          diasAcumulados:       0,
          desechos:             desechos ?? null,
        },
      }),
      this.prisma.company.update({
        where: { id: companyId },
        data: { tireCount: { increment: 1 } },
      }),
      ...(vehicleId
        ? [this.prisma.vehicle.update({
            where: { id: vehicleId },
            data: { tireCount: { increment: 1 } },
          })]
        : []),
    ]);

    return newTire;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BULK UPLOAD
  // ═══════════════════════════════════════════════════════════════════════════
  async bulkUploadTires(file: { buffer: Buffer }, companyId: string) {
    const wb    = XLSX.read(file.buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows: Record<string, string>[] = XLSX.utils.sheet_to_json(sheet, {
      raw:    false,
      defval: '',
    });

    const isFormatB = isFormatBDetect(rows);
    const headerMap = isFormatB ? HEADER_MAP_B : HEADER_MAP_A;
    const get       = (row: Record<string, string>, h: string) => getCell(row, h, headerMap);

    this.logger.log(
      `Bulk upload: Format ${isFormatB ? 'FORMAT B (New)' : 'FORMAT A (Original)'}, ${rows.length} rows`,
    );

    // Debug log of raw header keys from first row
    if (rows.length > 0) {
      this.logger.debug(`First row raw keys: ${JSON.stringify(Object.keys(rows[0]))}`);
    }

    // ── Tracking state ───────────────────────────────────────────────────────
    const tireDataMap  = new Map<string, { lastVida: string; lastCosto: number }>();
    const processedIds = new Set<string>();
    const errors:   string[] = [];
    const warnings: string[] = [];

    let lastSeenTipoVHC = '';
    let lastSeenPlaca   = '';

    // ────────────────────────────────────────────────────────────────────────
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row    = rows[rowIndex];
      const rowNum = rowIndex + 2; // human-readable: 1-based + header row

      try {
        // ── Carry-forward for sparse Format B rows ──────────────────────────
        if (isFormatB) {
          const currentTipoVHC = get(row, 'tipovhc')?.trim();
          const currentPlaca   = get(row, 'placa_vehiculo')?.trim();
          if (currentTipoVHC) lastSeenTipoVHC = currentTipoVHC;
          if (currentPlaca)   lastSeenPlaca   = currentPlaca;
        }

        // ── Tire ID resolution ──────────────────────────────────────────────
        const tirePlacaRaw = get(row, 'llanta')?.trim();
        let   tirePlaca: string;

        if (needsIdGeneration(tirePlacaRaw)) {
          tirePlaca = generateTireId().toLowerCase();
        } else {
          tirePlaca = tirePlacaRaw.toLowerCase();
        }

        // Duplicate guard — allow if there is vehicle context (re-upload scenario)
        if (processedIds.has(tirePlaca)) {
          const placaVehiculoCheck = isFormatB
            ? (get(row, 'placa_vehiculo')?.trim() || lastSeenPlaca)
            : get(row, 'placa_vehiculo')?.trim();

          if (!placaVehiculoCheck) {
            errors.push(
              `Error: Duplicate tire ID "${tirePlaca}" found in row ${rowNum} with no vehicle context. Skipping.`,
            );
            continue;
          }
        }
        processedIds.add(tirePlaca);

        // ── Core tire fields ────────────────────────────────────────────────
        const marca     = get(row, 'marca').toLowerCase();
        let   diseno    = get(row, 'diseno_original').toLowerCase();
        const dimension = get(row, 'dimension').toLowerCase();
        const eje       = get(row, 'eje').toLowerCase();
        const posicion  = parseInt(get(row, 'posicion') || '0', 10);

        let tipovhc = isFormatB
          ? (get(row, 'tipovhc')?.trim() || lastSeenTipoVHC)
          : get(row, 'tipovhc')?.trim();
        tipovhc = normalizeTipoVHC(tipovhc);

        // ── Depth readings ──────────────────────────────────────────────────
        const profIntEarly = parseFloat(get(row, 'profundidad_int') || '0');
        const profCenEarly = parseFloat(get(row, 'profundidad_cen') || '0');
        const profExtEarly = parseFloat(get(row, 'profundidad_ext') || '0');

        const profInt       = profIntEarly;
        const profCen       = profCenEarly;
        const profExt       = profExtEarly;
        const hasInspection = profInt > 0 || profCen > 0 || profExt > 0;
        const minDepth      = hasInspection ? calcMinDepth(profInt, profCen, profExt) : 0;

        // ── Initial tread depth (inferred if missing) ───────────────────────
        let profundidadInicial = parseFloat(get(row, 'profundidad_inicial') || '0');
        if (!profundidadInicial || profundidadInicial <= 0) {
          const maxObservedDepth = Math.max(profIntEarly, profCenEarly, profExtEarly);
          if (maxObservedDepth > 0) {
            profundidadInicial = maxObservedDepth > CONSTANTS.DEFAULT_PROFUNDIDAD_INICIAL
              ? maxObservedDepth + 1
              : CONSTANTS.DEFAULT_PROFUNDIDAD_INICIAL;
            warnings.push(`Row ${rowNum}: profundidad inicial inferred as ${profundidadInicial}mm`);
          } else {
            profundidadInicial = CONSTANTS.DEFAULT_PROFUNDIDAD_INICIAL;
            warnings.push(`Row ${rowNum}: Using default profundidad inicial: ${CONSTANTS.DEFAULT_PROFUNDIDAD_INICIAL}mm`);
          }
        }

        // ── Vida / reencauche detection ─────────────────────────────────────
        let vidaValor       = '';
        let needsReencauche = false;
        let bandaName       = '';

        if (isFormatB) {
          const marcaBanda = normalize(get(row, 'marca_banda'));
          bandaName        = get(row, 'banda_name').toLowerCase();
          if (marcaBanda.includes('reencauche') || marcaBanda.includes('rencauche')) {
            vidaValor       = 'nueva';
            needsReencauche = true;
          } else {
            vidaValor = 'nueva';
          }
        } else {
          vidaValor = get(row, 'vida').trim().toLowerCase();
          if (vidaValor === 'rencauche' || vidaValor === 'reencauche') {
            vidaValor = 'reencauche1';
          }
        }

        // ── Vehicle placa ───────────────────────────────────────────────────
        let placaVehiculo = isFormatB
          ? (get(row, 'placa_vehiculo')?.trim() || lastSeenPlaca)
          : get(row, 'placa_vehiculo')?.trim();
        placaVehiculo = placaVehiculo?.toLowerCase();

        const kilometrosVehiculo = parseFloat(get(row, 'kilometros_vehiculo') || '0');

        // ── Resolve or create vehicle ───────────────────────────────────────
        let vehicle: any = null;

        if (placaVehiculo) {
          vehicle = await this.prisma.vehicle.findFirst({ where: { placa: placaVehiculo } });

          if (!vehicle) {
            vehicle = await this.vehicleService.createVehicle({
              placa:             placaVehiculo,
              kilometrajeActual: kilometrosVehiculo,
              carga:             '',
              pesoCarga:         0,
              tipovhc,
              companyId,
              cliente:           '',
            });
          } else if (kilometrosVehiculo > (vehicle.kilometrajeActual || 0)) {
            await this.vehicleService.updateKilometraje(vehicle.id, kilometrosVehiculo);
            vehicle.kilometrajeActual = kilometrosVehiculo;
          }
        }

        // ── Back-fill tipovhc on vehicle if it was missing ──────────────────
        if (vehicle && tipovhc && !vehicle.tipovhc) {
          await this.prisma.vehicle.update({
            where: { id: vehicle.id },
            data:  { tipovhc },
          });
          vehicle.tipovhc = tipovhc;
        }

        // ── Market data canonicalization ────────────────────────────────────
        const { canonicalBrand, canonicalDiseno, canonicalDimension } =
          await this.marketDataService.syncTireWithMarketData(marca, diseno, dimension);

        const finalMarca     = canonicalBrand;
        const finalDiseno    = canonicalDiseno;
        const finalDimension = canonicalDimension;
        diseno = finalDiseno;

        // ── Dates ───────────────────────────────────────────────────────────
        const fechaInstalacionRaw = get(row, 'fecha_instalacion');
        const fechaInstalacion    = fechaInstalacionRaw
          ? new Date(fechaInstalacionRaw)
          : new Date();
        const now = new Date();

        // ── Cost: from Excel first, market data as fallback ─────────────────
        const costoRaw  = get(row, 'costo');
        let   costoCell = parseCurrency(costoRaw);

        if (costoCell <= 0) {
          costoCell = await this.fetchTirePriceFromMarketData(finalMarca, finalDiseno, finalDimension);
          warnings.push(`Row ${rowNum}: Cost fetched from market data: $${costoCell}`);
        }

        // ── KM estimation (priority order) ──────────────────────────────────
        // Priority: (1) explicit km from excel  (2) vehicle odometer
        //           (3) wear-based estimate      (4) time-based fallback
        const isPremiumTire     = costoCell >= CONSTANTS.PREMIUM_TIRE_THRESHOLD;
        const kmLlantaExcel     = parseFloat(get(row, 'kilometros_llanta') || '0');
        const usableDepth       = profundidadInicial - CONSTANTS.LIMITE_LEGAL_MM;
        const mmWorn            = profundidadInicial - minDepth;
        const tempDiasEnUso     = Math.max(
          Math.floor((now.getTime() - fechaInstalacion.getTime()) / CONSTANTS.MS_POR_DIA),
          1,
        );

        let kilometrosEstimados = 0;
        let shouldEstimateTime  = false;

        if (kmLlantaExcel > 0) {
          // (1) Explicit tire km provided — always trust this first
          kilometrosEstimados = kmLlantaExcel;
        } else if (kilometrosVehiculo > 0) {
          // (2) Vehicle odometer — use directly as the tire's km base
          kilometrosEstimados = kilometrosVehiculo;
        } else if (hasInspection && mmWorn > 0 && usableDepth > 0) {
          // (3) Wear-based estimation (no km data at all)
          const expectedLifetimeKm = isPremiumTire
            ? CONSTANTS.PREMIUM_TIRE_EXPECTED_KM
            : CONSTANTS.STANDARD_TIRE_EXPECTED_KM;
          const kmPerMm       = expectedLifetimeKm / usableDepth;
          kilometrosEstimados = Math.round(kmPerMm * mmWorn);
          shouldEstimateTime  = true;
          warnings.push(`Row ${rowNum}: KM estimated from wear — ${kilometrosEstimados} km`);
        } else {
          // (4) Time-based fallback (last resort)
          kilometrosEstimados = Math.round((tempDiasEnUso / 30) * CONSTANTS.KM_POR_MES);
        }

        let diasEnUso = tempDiasEnUso;
        if (shouldEstimateTime && tempDiasEnUso < CONSTANTS.RECENT_REGISTRATION_DAYS && kilometrosEstimados > 0) {
          const kmPerDay = CONSTANTS.KM_POR_MES / 30;
          diasEnUso      = Math.max(Math.round(kilometrosEstimados / kmPerDay), 1);
          warnings.push(`Row ${rowNum}: Time estimated from kilometers - ${diasEnUso} days`);
        }

        const mesesEnUso = diasEnUso / 30;

        // ── Match existing tire (by placa, then by vehicle+position) ─────────
        let existingTireMatch: any = null;

        if (!needsIdGeneration(tirePlacaRaw)) {
          existingTireMatch = await this.prisma.tire.findFirst({
            where: { placa: tirePlaca },
          });
        }

        if (!existingTireMatch && vehicle && posicion > 0) {
          existingTireMatch = await this.prisma.tire.findFirst({
            where: { vehicleId: vehicle.id, posicion },
          });
        }

        // ── BRANCH A: existing tire → append new inspection ───────────────
        if (existingTireMatch) {
          if (hasInspection) {
            const existingInspections = this.castInspections(existingTireMatch.inspecciones);

            // Use whichever km is larger: existing accumulated or this row's estimate
            const existingKm      = existingTireMatch.kilometrosRecorridos || 0;
            const kmForInspection = Math.max(kilometrosEstimados, existingKm);
            const totalCostExisting = this.sumCosto(existingTireMatch.costo);

            const metrics = calcCpkMetrics(
              totalCostExisting,
              kmForInspection,
              mesesEnUso,
              existingTireMatch.profundidadInicial || profundidadInicial,
              minDepth,
            );

            const newInspection: InspectionEntry = {
              fecha:                fechaInstalacion.toISOString(),
              profundidadInt:       profInt,
              profundidadCen:       profCen,
              profundidadExt:       profExt,
              diasEnUso,
              mesesEnUso,
              kilometrosRecorridos: kmForInspection,
              kmActualVehiculo:     kilometrosVehiculo || 0,
              cpk:                  metrics.cpk,
              cpkProyectado:        metrics.cpkProyectado,
              cpt:                  metrics.cpt,
              cptProyectado:        metrics.cptProyectado,
              imageUrl:             get(row, 'imageurl') || '',
            };

            // Sort inspections: deepest tread first (newest → oldest life)
            const sortedInspecciones = [...existingInspections, newInspection].sort((a, b) => {
              const minA = Math.min(
                a.profundidadInt ?? Infinity,
                a.profundidadCen ?? Infinity,
                a.profundidadExt ?? Infinity,
              );
              const minB = Math.min(
                b.profundidadInt ?? Infinity,
                b.profundidadCen ?? Infinity,
                b.profundidadExt ?? Infinity,
              );
              return minB - minA;
            });

            await this.prisma.tire.update({
              where: { id: existingTireMatch.id },
              data: {
                inspecciones:        toJson(sortedInspecciones),
                kilometrosRecorridos: kmForInspection,
                diasAcumulados:      diasEnUso,
              },
            });

            this.triggerMarketCpkUpdate(
              existingTireMatch.marca,
              existingTireMatch.diseno,
              existingTireMatch.dimension,
            );
          }

        } else {
          // ── BRANCH B: new tire ────────────────────────────────────────────
          const existingByPlaca = await this.prisma.tire.findFirst({
            where: { placa: tirePlaca },
          });
          if (existingByPlaca) {
            errors.push(`Error: Tire ID "${tirePlaca}" already exists (row ${rowNum}). Skipping.`);
            continue;
          }

          const costosActuales: CostoEntry[] = costoCell > 0
            ? [{ fecha: now.toISOString(), valor: costoCell }]
            : [];

          const totalCost = costosActuales.reduce(
            (sum: number, c: any) => sum + (typeof c?.valor === 'number' ? c.valor : 0),
            0,
          );

          const vidaArray: VidaEntry[] = vidaValor
            ? [{ fecha: now.toISOString(), valor: vidaValor }]
            : [];

          const tire = await (this.prisma.tire.create as any)({
            data: {
              placa:            tirePlaca,
              marca:            finalMarca,
              diseno:           finalDiseno,
              dimension:        finalDimension,
              eje,
              posicion,
              profundidadInicial,
              companyId,
              vehicleId:        vehicle?.id ?? null,
              fechaInstalacion,
              vida:             vidaArray,
              costo:            costosActuales,
              inspecciones:     [],
              eventos:          [],
            },
          });

          // ── Counters ────────────────────────────────────────────────────
          await Promise.all([
            this.prisma.company.update({
              where: { id: companyId },
              data:  { tireCount: { increment: 1 } },
            }),
            vehicle
              ? this.prisma.vehicle.update({
                  where: { id: vehicle.id },
                  data:  { tireCount: { increment: 1 } },
                })
              : Promise.resolve(),
          ]);

          if (hasInspection) {
            // ── Calculate CPK for this brand-new tire's first inspection ──
            const metrics = calcCpkMetrics(
              totalCost,
              kilometrosEstimados,
              mesesEnUso,
              profundidadInicial,
              minDepth,
            );

            const inspecciones: InspectionEntry[] = [{
              fecha:                now.toISOString(),
              profundidadInt:       profInt,
              profundidadCen:       profCen,
              profundidadExt:       profExt,
              diasEnUso,
              mesesEnUso,
              kilometrosRecorridos: kilometrosEstimados,
              kmActualVehiculo:     kilometrosVehiculo || 0,
              cpk:                  metrics.cpk,
              cpkProyectado:        metrics.cpkProyectado,
              cpt:                  metrics.cpt,
              cptProyectado:        metrics.cptProyectado,
              imageUrl:             get(row, 'imageurl') || '',
            }];

            await this.prisma.tire.update({
              where: { id: tire.id },
              data: {
                costo:               toJson(costosActuales),
                vida:                toJson(vidaArray),
                inspecciones:        toJson(inspecciones),
                kilometrosRecorridos: kilometrosEstimados,
                diasAcumulados:      diasEnUso,
              },
            });

            this.triggerMarketCpkUpdate(finalMarca, finalDiseno, finalDimension);
          } else {
            await this.prisma.tire.update({
              where: { id: tire.id },
              data: {
                costo:               toJson(costosActuales),
                vida:                toJson(vidaArray),
                kilometrosRecorridos: kilometrosEstimados,
                diasAcumulados:      diasEnUso,
              },
            });
          }

          // ── Auto-reencauche for Format B tires ───────────────────────────
          if (needsReencauche) {
            try {
              await this.updateVida(
                tire.id,
                'reencauche1',
                bandaName || finalDiseno,
                CONSTANTS.REENCAUCHE_COST,
                profundidadInicial,
                undefined,
              );
            } catch (error: any) {
              errors.push(
                `Error performing reencauche for tire ${tirePlaca} (row ${rowNum}): ${error.message}`,
              );
            }
          }
        }

        // ── Track last seen vida/costo per tire ID ──────────────────────────
        const lastData = tireDataMap.get(tirePlaca) || { lastVida: '', lastCosto: -1 };
        lastData.lastVida = vidaValor;
        tireDataMap.set(tirePlaca, lastData);

      } catch (err: any) {
        this.logger.error(`Bulk upload row ${rowNum} failed: ${err.message}`, err.stack);
        errors.push(`Row ${rowNum}: Unexpected error — ${err.message}`);
      }
    } // ── end row loop

    const successCount = processedIds.size;
    const errorCount   = errors.length;
    const warningCount = warnings.length;

    let message = `Carga masiva completada. ${successCount} llantas procesadas exitosamente.`;
    if (warningCount > 0) message += ` ${warningCount} advertencias encontradas.`;
    if (errorCount > 0)   message += ` ${errorCount} errores encontrados.`;

    return {
      message,
      success:  successCount,
      errors:   errorCount,
      warnings: warningCount,
      details:  { errors, warnings },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FIND TIRES
  // ═══════════════════════════════════════════════════════════════════════════
  async findTiresByCompany(companyId: string) {
    return await this.prisma.tire.findMany({ where: { companyId } });
  }

  async findTiresByVehicle(vehicleId: string) {
    if (!vehicleId) throw new BadRequestException('vehicleId is required');
    return await this.prisma.tire.findMany({ where: { vehicleId } });
  }

  async findAllTires() {
    return await this.prisma.tire.findMany();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UPDATE INSPECTION
  // ═══════════════════════════════════════════════════════════════════════════
  async updateInspection(tireId: string, updateDto: UpdateInspectionDto) {
    // ── Guard: all-zero depths means nothing to record ──────────────────────
    if (
      updateDto.profundidadInt === 0 &&
      updateDto.profundidadCen === 0 &&
      updateDto.profundidadExt === 0
    ) {
      return this.prisma.tire.findUnique({ where: { id: tireId } });
    }

    // ── Fetch tire ───────────────────────────────────────────────────────────
    const tire = await this.prisma.tire.findUnique({ where: { id: tireId } });
    if (!tire) throw new BadRequestException('Tire not found');
    if (!tire.vehicleId) throw new BadRequestException('Tire is not associated with a vehicle');

    const vehicle = await this.prisma.vehicle.findUnique({ where: { id: tire.vehicleId } });
    if (!vehicle) throw new BadRequestException('Vehicle not found for tire');

    const newVehicleKm     = updateDto.newKilometraje || 0;
    const odometerProvided = newVehicleKm > 0;
    const priorTireKm      = tire.kilometrosRecorridos || 0;

    // ── KM delta calculation ─────────────────────────────────────────────────
    // Formula: tireKm = priorTireKm + (newVehicleKm - lastKnownVehicleKm)
    // lastKnownVehicleKm comes from the most-recent inspection's kmActualVehiculo
    // field — no extra schema column needed.
    let kilometrosRecorridos: number;

const deltaFromFrontend = updateDto.kmDelta ?? 0;

if (deltaFromFrontend > 0) {
  // Delta sent directly — always correct regardless of update order
  kilometrosRecorridos = priorTireKm + deltaFromFrontend;
} else if (odometerProvided) {
  // Fallback: derive delta from inspection history if available
  const inspecciones = this.castInspections(tire.inspecciones);
  if (inspecciones.length > 0) {
    const sorted = [...inspecciones].sort(
      (a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime(),
    );
    const lastKnownVehicleKm = sorted[0].kmActualVehiculo || vehicle.kilometrajeActual;
    const vehicleDelta = Math.max(newVehicleKm - lastKnownVehicleKm, 0);
    kilometrosRecorridos = priorTireKm + vehicleDelta;
  } else {
    kilometrosRecorridos = priorTireKm;
  }
} else {
  kilometrosRecorridos = priorTireKm;
}

    // Persist updated tire km before calculating metrics
    await this.prisma.tire.update({
      where: { id: tireId },
      data:  { kilometrosRecorridos },
    });

    // ── Time in use ──────────────────────────────────────────────────────────
    const now              = new Date();
    const fechaInstalacion = tire.fechaInstalacion ?? now;
    const diasEnUso        = Math.max(
      Math.floor(
        (now.getTime() - new Date(fechaInstalacion).getTime()) / CONSTANTS.MS_POR_DIA,
      ),
      1,
    );
    const mesesEnUso = diasEnUso / 30;

    // ── Depth values ─────────────────────────────────────────────────────────
    const minDepth           = Math.min(
      updateDto.profundidadInt,
      updateDto.profundidadCen,
      updateDto.profundidadExt,
    );
    const profundidadInicial = tire.profundidadInicial;
    const mmWorn             = profundidadInicial - minDepth;

    // If km ended up 0, fall back to time-based estimate so CPK never divides by zero
    const effectiveKm = kilometrosRecorridos > 0
      ? kilometrosRecorridos
      : Math.round(mesesEnUso * CONSTANTS.KM_POR_MES);

    // ── Total cost ───────────────────────────────────────────────────────────
    const totalCost = this.sumCosto(tire.costo);

    // ── CPK, CPT and projected metrics ──────────────────────────────────────
    const metrics = calcCpkMetrics(totalCost, effectiveKm, mesesEnUso, profundidadInicial, minDepth);

    // ── Image upload (base64 → S3) ────────────────────────────────────────────
    let finalImageUrl = updateDto.imageUrl;
    if (updateDto.imageUrl?.startsWith('data:')) {
      const base64Data = updateDto.imageUrl.split(',')[1];
      const fileBuffer = Buffer.from(base64Data, 'base64');
      const fileName   = `tire-inspections/${tireId}-${Date.now()}.jpg`;
      finalImageUrl    = await uploadFileToS3(fileBuffer, fileName, 'image/jpeg');
    }

    // ── Build new inspection record ──────────────────────────────────────────
    const currentInspections = this.castInspections(tire.inspecciones);

    const newInspection: InspectionEntry = {
      profundidadInt: updateDto.profundidadInt,
      profundidadCen: updateDto.profundidadCen,
      profundidadExt: updateDto.profundidadExt,
      imageUrl:       finalImageUrl,
      fecha:          now.toISOString(),
      diasEnUso,
      mesesEnUso,
      kilometrosRecorridos,
      kmEfectivos:     effectiveKm,
      // ← key field: used by the NEXT inspection to compute vehicle-km delta
      kmActualVehiculo: odometerProvided ? newVehicleKm : (vehicle.kilometrajeActual || 0),
      cpk:              metrics.cpk,
      cpkProyectado:    metrics.cpkProyectado,
      cpt:              metrics.cpt,
      cptProyectado:    metrics.cptProyectado,
    };

    const finalTire = await this.prisma.tire.update({
      where: { id: tireId },
      data: {
        inspecciones:  toJson([...currentInspections, newInspection]),
        diasAcumulados: diasEnUso,
      },
    });

    // ── Update vehicle odometer ───────────────────────────────────────────────
    if (odometerProvided) {
      await this.prisma.vehicle.update({
        where: { id: vehicle.id },
        data:  { kilometrajeActual: newVehicleKm },
      });
    }

    // ── Notifications ─────────────────────────────────────────────────────────
    await this.notificationsService.deleteByTire(finalTire.id);

    const analysis       = this.analyzeTire(finalTire);
    const recommendation = analysis?.recomendaciones?.[0] ?? '';

    if (recommendation.startsWith('🔴') || recommendation.startsWith('🟡')) {
      await this.notificationsService.createNotification({
        title:     `Llantas - ${recommendation.includes('🔴') ? 'Crítico' : 'Precaución'}`,
        message:   recommendation,
        type:      recommendation.includes('🔴') ? 'critical' : 'warning',
        tireId:    finalTire.id,
        vehicleId: finalTire.vehicleId ?? undefined,
        companyId: finalTire.companyId ?? undefined,
      });
    }

    // ── Market data CPK update (fire-and-forget) ──────────────────────────────
    this.triggerMarketCpkUpdate(finalTire.marca, finalTire.diseno, finalTire.dimension);

    return finalTire;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UPDATE VIDA
  // ═══════════════════════════════════════════════════════════════════════════
  async updateVida(
    tireId: string,
    newValor: string | undefined,
    banda?: string,
    costo?: number,
    profundidadInicial?: number | string,
    desechoData?: {
      causales: string;
      milimetrosDesechados: number;
    },
  ) {
    if (!newValor) {
      throw new BadRequestException(`El campo 'valor' es obligatorio`);
    }

    const normalizedValor = newValor.toLowerCase() as VidaValue;
    const newIndex        = CONSTANTS.VIDA_SEQUENCE.indexOf(normalizedValor);
    if (newIndex < 0) {
      throw new BadRequestException(`"${newValor}" no es un valor válido`);
    }

    // ── Validate profundidadInicial (required for every state except 'fin') ──
    let parsedProfundidad: number | null = null;

    if (normalizedValor !== 'fin') {
      if (
        profundidadInicial === undefined ||
        profundidadInicial === null ||
        (typeof profundidadInicial === 'string' && profundidadInicial.trim() === '')
      ) {
        throw new BadRequestException('La profundidad inicial es requerida para este valor de vida.');
      }

      parsedProfundidad =
        typeof profundidadInicial === 'string'
          ? parseFloat(profundidadInicial)
          : Number(profundidadInicial);

      if (isNaN(parsedProfundidad) || parsedProfundidad <= 0) {
        throw new BadRequestException('La profundidad inicial debe ser un número mayor a 0.');
      }
    }

    const tire = await this.prisma.tire.findUnique({ where: { id: tireId } });
    if (!tire) throw new BadRequestException('Tire not found');

    const vidaArray = this.castVida(tire.vida);

    // ── Enforce forward-only sequence ───────────────────────────────────────
    const lastEntry = vidaArray.length ? vidaArray[vidaArray.length - 1] : null;
    if (lastEntry) {
      const lastIndex = CONSTANTS.VIDA_SEQUENCE.indexOf(
        lastEntry.valor.toLowerCase() as VidaValue,
      );
      if (lastIndex < 0) throw new BadRequestException('Último valor de vida inválido');
      if (newIndex <= lastIndex) {
        throw new BadRequestException(
          `Debe avanzar en la secuencia. Último valor: "${lastEntry.valor}".`,
        );
      }
    }

    const updateData: Record<string, any> = {
      vida: [
        ...vidaArray,
        { fecha: new Date().toISOString(), valor: normalizedValor },
      ],
    };

    if (normalizedValor !== 'fin' && parsedProfundidad !== null) {
      updateData.profundidadInicial = parsedProfundidad;
    }

    // ── Update design name if a new banda is provided ───────────────────────
    if (banda?.trim()) {
      updateData.diseno = banda.trim();
    }

    // ── Reencauche: append new cost entry ───────────────────────────────────
    if (normalizedValor.startsWith('reencauche')) {
      const existingCosto = this.castCosto(tire.costo);
      let costoValue = 0;

      if (typeof costo === 'number' && costo > 0) {
        costoValue = costo;
      } else if (normalizedValor === 'reencauche1' && existingCosto.length) {
        const lastC = existingCosto[existingCosto.length - 1] as any;
        costoValue  = typeof lastC.valor === 'number' ? lastC.valor : 0;
      }

      if (costoValue > 0) {
        updateData.costo = [
          ...existingCosto,
          { fecha: new Date().toISOString(), valor: costoValue },
        ];
      }
    }

    // ── Reencauche1: snapshot first-life metrics into primeraVida ──────────
    if (normalizedValor === 'reencauche1') {
      const inspecciones = this.castInspections(tire.inspecciones);
      let cpk = 0;
      if (inspecciones.length) {
        const sorted = [...inspecciones].sort(
          (a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime(),
        );
        cpk = sorted[0]?.cpk ?? 0;
      }

      const designValue     = banda?.trim() || tire.diseno;
      const existingCosto   = this.castCosto(tire.costo);
      const costoForPrimera =
        typeof costo === 'number' && costo > 0
          ? costo
          : existingCosto.length
            ? (existingCosto[existingCosto.length - 1] as any).valor as number
            : 0;

      updateData.primeraVida = [{
        diseno:     designValue,
        cpk,
        costo:      costoForPrimera,
        kilometros: tire.kilometrosRecorridos || 0,
      } as PrimeraVidaEntry];
    }

    // ── Fin: compute remanente, detach from vehicle ──────────────────────────
    if (normalizedValor === 'fin') {
      updateData.vehicleId = null;

      if (tire.vehicleId) {
        await this.prisma.vehicle.update({
          where: { id: tire.vehicleId },
          data:  { tireCount: { decrement: 1 } },
        });
      }

      if (!desechoData?.causales || desechoData.milimetrosDesechados === undefined) {
        throw new BadRequestException('Información de desecho incompleta');
      }

      // remanente = cpkActual × (km per mm) × mm wasted above legal limit
      const inspecciones = this.castInspections(tire.inspecciones);
      const lastInsp     = inspecciones.length
        ? [...inspecciones].sort(
            (a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime(),
          )[0]
        : null;

      const cpkActual   = lastInsp?.cpk ?? 0;
      const usableDepth = (tire.profundidadInicial ?? 0) - CONSTANTS.LIMITE_LEGAL_MM;
      const kmPerMm     = usableDepth > 0 && tire.kilometrosRecorridos > 0
        ? tire.kilometrosRecorridos / usableDepth
        : 0;

      const remanente = cpkActual > 0
        ? cpkActual * kmPerMm * desechoData.milimetrosDesechados
        : 0;

      updateData.desechos = {
        causales:             desechoData.causales,
        milimetrosDesechados: desechoData.milimetrosDesechados,
        remanente:            Number(remanente.toFixed(2)),
        fecha:                new Date().toISOString(),
      } as DesechoData;
    }

    const finalTire = await this.prisma.tire.update({
      where: { id: tireId },
      data:  updateData,
    });

    await this.notificationsService.deleteByTire(finalTire.id);

    return finalTire;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UPDATE EVENTO
  // ═══════════════════════════════════════════════════════════════════════════
  async updateEvento(tireId: string, newValor: string) {
    const tire = await this.prisma.tire.findUnique({ where: { id: tireId } });
    if (!tire) throw new BadRequestException('Tire not found');

    const eventosArray = (Array.isArray(tire.eventos) ? tire.eventos : []) as unknown as EventoEntry[];
    const updatedEventos: EventoEntry[] = [
      ...eventosArray,
      { valor: newValor, fecha: new Date().toISOString() },
    ];

    return this.prisma.tire.update({
      where: { id: tireId },
      data:  { eventos: toJson(updatedEventos) },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UPDATE POSITIONS
  // ═══════════════════════════════════════════════════════════════════════════
  async updatePositions(placa: string, updates: { [position: string]: string | string[] }) {
    const vehicle = await this.prisma.vehicle.findFirst({ where: { placa } });
    if (!vehicle) throw new BadRequestException('Vehicle not found for the given placa');

    // Validate ownership of ALL tires in one query before touching anything
    const allTireIds = Object.values(updates).flatMap(v => (Array.isArray(v) ? v : [v]));
    const tires      = await this.prisma.tire.findMany({ where: { id: { in: allTireIds } } });

    for (const tire of tires) {
      if (!tire) throw new BadRequestException(`Tire not found`);
      if (tire.vehicleId !== vehicle.id) {
        throw new BadRequestException(
          `Tire with id ${tire.id} does not belong to vehicle with plate ${placa}`,
        );
      }
    }

    // Execute all position updates in one transaction
    const ops: Prisma.PrismaPromise<any>[] = Object.entries(updates).flatMap(([pos, ids]) => {
      const tireIds = Array.isArray(ids) ? ids : [ids];
      return tireIds.map(tireId =>
        this.prisma.tire.update({
          where: { id: tireId },
          data:  { posicion: pos === '0' ? 0 : parseInt(pos, 10) },
        }),
      );
    });

    await this.prisma.$transaction(ops);
    return { message: 'Positions updated successfully' };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ANALYZE TIRES FOR A VEHICLE
  // ═══════════════════════════════════════════════════════════════════════════
  async analyzeTires(vehiclePlaca: string) {
    const vehicle = await this.prisma.vehicle.findFirst({ where: { placa: vehiclePlaca } });
    if (!vehicle) throw new BadRequestException(`Vehicle with placa ${vehiclePlaca} not found`);

    const tires = await this.prisma.tire.findMany({ where: { vehicleId: vehicle.id } });
    if (!tires || tires.length === 0) {
      throw new BadRequestException(`No tires found for vehicle with placa ${vehiclePlaca}`);
    }

    const analysisResults = await Promise.all(tires.map(tire => this.analyzeTire(tire)));
    return { vehicle, tires: analysisResults };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REMOVE INSPECTION
  // ═══════════════════════════════════════════════════════════════════════════
  async removeInspection(tireId: string, fecha: string) {
    const tire = await this.prisma.tire.findUnique({ where: { id: tireId } });
    if (!tire) throw new BadRequestException('Tire not found');

    const inspeccionesArray = this.castInspections(tire.inspecciones);
    const updated           = inspeccionesArray.filter(i => i.fecha !== fecha);

    await this.prisma.tire.update({
      where: { id: tireId },
      data:  { inspecciones: toJson(updated) },
    });

    return { message: 'Inspección eliminada' };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ASSIGN / UNASSIGN TIRES
  // ═══════════════════════════════════════════════════════════════════════════
  async assignTiresToVehicle(vehiclePlaca: string, tireIds: string[]) {
    const vehicle = await this.prisma.vehicle.findFirst({ where: { placa: vehiclePlaca } });
    if (!vehicle) throw new BadRequestException('Vehicle not found');

    await (this.prisma.tire.updateMany as any)({
      where: { id: { in: tireIds } },
      data:  { vehicleId: vehicle.id },
    });

    await this.prisma.vehicle.update({
      where: { id: vehicle.id },
      data:  { tireCount: { increment: tireIds.length } },
    });

    return { message: 'Tires assigned successfully', count: tireIds.length };
  }

  async unassignTiresFromVehicle(tireIds: string[]) {
    const tires      = await this.prisma.tire.findMany({ where: { id: { in: tireIds } } });
    const vehicleIds = [
      ...new Set(tires.map(t => t.vehicleId).filter((id): id is string => id !== null)),
    ];

    for (const vid of vehicleIds) {
      const count = tires.filter(t => t.vehicleId === vid).length;
      await this.prisma.vehicle.update({
        where: { id: vid },
        data:  { tireCount: { decrement: count } },
      });
    }

    await this.prisma.tire.updateMany({
      where: { id: { in: tireIds } },
      data:  { vehicleId: null, posicion: 0 },
    });

    return { message: 'Tires unassigned successfully', count: tireIds.length };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE: TIRE ANALYSIS
  // ═══════════════════════════════════════════════════════════════════════════
  private analyzeTire(tire: any) {
    if (!Array.isArray(tire.inspecciones) || tire.inspecciones.length === 0) {
      return {
        id:               tire.id,
        posicion:         tire.posicion,
        profundidadActual: null,
        inspecciones:     [],
        recomendaciones:  [
          '🔴 Inspección requerida: No se han registrado inspecciones. Realizar una evaluación inmediata.',
        ],
      };
    }

    const lastInspections = this.castInspections(tire.inspecciones)
      .sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime())
      .slice(0, 3);

    const latest = lastInspections[0];

    const pInt = Number(latest.profundidadInt) || 0;
    const pCen = Number(latest.profundidadCen) || 0;
    const pExt = Number(latest.profundidadExt) || 0;

    const profundidadActual = (pInt + pCen + pExt) / 3;

    // CPK is read from the inspection JSON — not from the tire root field
    const cpk: number = latest.cpk ?? 0;

    const delta1 = Math.abs(pInt - pCen);
    const delta2 = Math.abs(pCen - pExt);
    const delta3 = Math.abs(pInt - pExt);

    let recomendacion = '';

    if (profundidadActual <= CONSTANTS.LIMITE_LEGAL_MM) {
      recomendacion = '🔴 Cambio inmediato: Desgaste crítico. Reemplazo urgente.';
    } else if (delta1 > 3 || delta2 > 3 || delta3 > 3) {
      recomendacion = '🟡 Desgaste irregular: Diferencias notables entre zonas. Revisar alineación o presión.';
    } else if (cpk > 0 && cpk < 5) {
      recomendacion = '🔴 CPK muy bajo: Alto costo por kilómetro. Evaluar desempeño de la llanta.';
    } else if (profundidadActual <= 4) {
      recomendacion = '🟡 Revisión frecuente: La profundidad está bajando. Monitorear en próximas inspecciones.';
    } else {
      recomendacion = '🟢 Buen estado: Sin hallazgos relevantes en esta inspección.';
    }

    return {
      id:               tire.id,
      posicion:         tire.posicion,
      profundidadActual,
      inspecciones:     lastInspections,
      recomendaciones:  [recomendacion],
      desechos:         tire.desechos ?? null,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE: JSON FIELD CASTS (type-safe access to Prisma JSON columns)
  // ═══════════════════════════════════════════════════════════════════════════
  private castInspections(raw: unknown): InspectionEntry[] {
    return Array.isArray(raw) ? (raw as InspectionEntry[]) : [];
  }

  private castVida(raw: unknown): VidaEntry[] {
    return Array.isArray(raw) ? (raw as VidaEntry[]) : [];
  }

  private castCosto(raw: unknown): CostoEntry[] {
    return Array.isArray(raw) ? (raw as CostoEntry[]) : [];
  }

  private sumCosto(raw: unknown): number {
    return this.castCosto(raw).reduce((sum, c) => sum + (c?.valor || 0), 0);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE: FIRE-AND-FORGET MARKET CPK UPDATE
  // ═══════════════════════════════════════════════════════════════════════════
  private triggerMarketCpkUpdate(marca: string, diseno: string, dimension: string): void {
    this.marketDataService
      .updateMarketCpkFromInspection(marca, diseno, dimension)
      .catch(err => this.logger.warn(`Market CPK update failed silently: ${err.message}`));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE: MARKET PRICE FETCH WITH PROGRESSIVE FALLBACK
  // ═══════════════════════════════════════════════════════════════════════════
  private async fetchTirePriceFromMarketData(
    marca: string,
    diseno: string,
    dimension: string,
  ): Promise<number> {
    try {
      // Level 1: exact brand + design + dimension
      let marketTire = await this.prisma.marketTire.findFirst({
        where: {
          brand:     { equals: marca,     mode: 'insensitive' },
          diseno:    { equals: diseno,    mode: 'insensitive' },
          dimension: { equals: dimension, mode: 'insensitive' },
        },
      });

      // Level 2: brand + design (any dimension)
      if (!marketTire) {
        marketTire = await this.prisma.marketTire.findFirst({
          where: {
            brand:  { equals: marca,  mode: 'insensitive' },
            diseno: { equals: diseno, mode: 'insensitive' },
          },
        });
      }

      // Level 3: brand only (most recent entry)
      if (!marketTire) {
        marketTire = await this.prisma.marketTire.findFirst({
          where:   { brand: { equals: marca, mode: 'insensitive' } },
          orderBy: { updatedAt: 'desc' },
        });
      }

      if (marketTire) {
        type PriceEntryLocal = { price: number; date: string; source?: string };
        const prices = Array.isArray(marketTire.prices)
          ? (marketTire.prices as PriceEntryLocal[])
          : [];

        // Use the most recent price entry if it meets the minimum threshold
        if (prices.length > 0) {
          const sortedPrices = [...prices].sort(
            (a, b) =>
              new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime(),
          );
          const latestPrice = sortedPrices[0]?.price;
          if (latestPrice && latestPrice >= CONSTANTS.MIN_VALID_PRICE) {
            return latestPrice;
          }
        }

        // Fallback: estimate from CPK × expected lifetime km
        if (marketTire.cpk && marketTire.cpk > 0) {
          const estimatedPrice = Math.round(
            marketTire.cpk * CONSTANTS.STANDARD_TIRE_EXPECTED_KM,
          );
          if (estimatedPrice >= CONSTANTS.MIN_VALID_PRICE) {
            return estimatedPrice;
          }
        }
      }

      return CONSTANTS.FALLBACK_TIRE_PRICE;
    } catch (error: any) {
      this.logger.error(`❌ Error fetching market data: ${error.message}`);
      return CONSTANTS.FALLBACK_TIRE_PRICE;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
// EDIT TIRE
// ═══════════════════════════════════════════════════════════════════════════

async editTire(tireId: string, dto: EditTireDto) {
  const tire = await this.prisma.tire.findUnique({ where: { id: tireId } });
  if (!tire) throw new BadRequestException('Tire not found');

  const updateData: Record<string, any> = {};

  // Helper: strip time component for same-day comparisons
  const toDateOnly = (isoString: string) =>
    new Date(isoString).toISOString().slice(0, 10);

  // ── 1. Brand / diseno / dimension changes ──────────────────────────────
  let newMarca     = dto.marca     ?? tire.marca;
  let newDiseno    = dto.diseno    ?? tire.diseno;
  let newDimension = dto.dimension ?? tire.dimension;

  const brandChanged     = dto.marca     !== undefined && dto.marca     !== tire.marca;
  const disenoChanged    = dto.diseno    !== undefined && dto.diseno    !== tire.diseno;
  const dimensionChanged = dto.dimension !== undefined && dto.dimension !== tire.dimension;

  if (brandChanged || disenoChanged || dimensionChanged) {
    const { canonicalBrand, canonicalDiseno, canonicalDimension } =
      await this.marketDataService.syncTireWithMarketData(newMarca, newDiseno, newDimension);

    newMarca     = canonicalBrand;
    newDiseno    = canonicalDiseno;
    newDimension = canonicalDimension;

    updateData.marca     = newMarca;
    updateData.diseno    = newDiseno;
    updateData.dimension = newDimension;

    this.triggerMarketCpkUpdate(newMarca, newDiseno, newDimension);
  }

  // ── 2. Simple scalar fields ────────────────────────────────────────────
  if (dto.eje !== undefined) updateData.eje = dto.eje;
  if (dto.posicion !== undefined) updateData.posicion = dto.posicion;
  if (dto.profundidadInicial !== undefined) {
    updateData.profundidadInicial = dto.profundidadInicial;
  }

  // ── 3. KM update — ONLY if value actually changed from what is stored ──
  const kmActuallyChanged =
    dto.kilometrosRecorridos !== undefined &&
    dto.kilometrosRecorridos !== tire.kilometrosRecorridos;

  if (kmActuallyChanged) {
    updateData.kilometrosRecorridos = dto.kilometrosRecorridos;

    const inspecciones = this.castInspections(tire.inspecciones);
    const costoArray   = this.castCosto(tire.costo);
    const profInicial  = dto.profundidadInicial ?? tire.profundidadInicial;

    const updatedInspections = inspecciones.map((insp) => {
      const inspDate = new Date(insp.fecha).getTime();

      // Only costs on or before this inspection's date
      const costUpToInsp = costoArray
        .filter((c) => new Date(c.fecha).getTime() <= inspDate)
        .reduce((sum, c) => sum + (c?.valor || 0), 0);

      const minDepth   = calcMinDepth(insp.profundidadInt, insp.profundidadCen, insp.profundidadExt);
      const mesesEnUso = insp.mesesEnUso || 1;

      // Keep the inspection's own recorded km — do not overwrite it
      const inspKm = insp.kilometrosRecorridos || dto.kilometrosRecorridos!;

      const metrics = calcCpkMetrics(costUpToInsp, inspKm, mesesEnUso, profInicial, minDepth);

      return {
        ...insp,
        cpk:           metrics.cpk,
        cpkProyectado: metrics.cpkProyectado,
        cpt:           metrics.cpt,
        cptProyectado: metrics.cptProyectado,
      };
    });

    updateData.inspecciones = toJson(updatedInspections);
  }

  // ── 4. Inspection depth edit → recalculate only that one inspection ─────
  if (dto.inspectionEdit) {
    const { fecha, profundidadInt, profundidadCen, profundidadExt } = dto.inspectionEdit;

    const inspecciones = this.castInspections(
      updateData.inspecciones ?? tire.inspecciones,
    );
    const costoArray  = this.castCosto(tire.costo);
    const profInicial = dto.profundidadInicial ?? tire.profundidadInicial;

    const updatedInspections = inspecciones.map((insp) => {
      if (insp.fecha !== fecha) return insp;

      const inspDate = new Date(insp.fecha).getTime();

      // Only costs on or before this inspection's date
      const costUpToInsp = costoArray
        .filter((c) => new Date(c.fecha).getTime() <= inspDate)
        .reduce((sum, c) => sum + (c?.valor || 0), 0);

      const minDepth   = calcMinDepth(profundidadInt, profundidadCen, profundidadExt);
      const km         = insp.kilometrosRecorridos || tire.kilometrosRecorridos || 0;
      const mesesEnUso = insp.mesesEnUso || 1;
      const metrics    = calcCpkMetrics(costUpToInsp, km, mesesEnUso, profInicial, minDepth);

      return {
        ...insp,
        profundidadInt,
        profundidadCen,
        profundidadExt,
        cpk:           metrics.cpk,
        cpkProyectado: metrics.cpkProyectado,
        cpt:           metrics.cpt,
        cptProyectado: metrics.cptProyectado,
      };
    });

    updateData.inspecciones = toJson(updatedInspections);
    this.triggerMarketCpkUpdate(
      updateData.marca ?? tire.marca,
      updateData.diseno ?? tire.diseno,
      updateData.dimension ?? tire.dimension,
    );
  }

  // ── 5. Costo edit → recalculate inspections on same day or after ────────
  if (dto.costoEdit) {
    const { fecha: costoFecha, newValor } = dto.costoEdit;
    const costoArray = this.castCosto(tire.costo);

    // Helper scoped here for same-day comparison
    const toDateOnly = (isoString: string) =>
      new Date(isoString).toISOString().slice(0, 10);

    // Update the matching cost entry
    const updatedCosto = costoArray.map((c) =>
      c.fecha === costoFecha ? { ...c, valor: newValor } : c,
    );
    updateData.costo = toJson(updatedCosto);

    const profInicial = dto.profundidadInicial ?? tire.profundidadInicial;

    const inspecciones = this.castInspections(
      updateData.inspecciones ?? tire.inspecciones,
    );

    const updatedInspections = inspecciones.map((insp) => {
      // Skip inspections that are strictly BEFORE the cost's date
      // Same day counts as affected — a cost added at 2pm affects
      // an inspection recorded at 10am on the same day
      if (toDateOnly(insp.fecha) < toDateOnly(costoFecha)) return insp;

      // Recalculate using costs up to and including this inspection's date
      // using the updated cost array so the edited value is reflected
      const inspDate = new Date(insp.fecha).getTime();
      const costUpToInsp = updatedCosto
        .filter((c) => toDateOnly(c.fecha) <= toDateOnly(insp.fecha))
        .reduce((sum, c) => sum + (c?.valor || 0), 0);

      this.logger.debug(
        `Inspection ${insp.fecha}: costUpToInsp=${costUpToInsp}, km=${insp.kilometrosRecorridos || tire.kilometrosRecorridos}, cpk will be recalculated`,
      );

      const minDepth   = calcMinDepth(insp.profundidadInt, insp.profundidadCen, insp.profundidadExt);
      const km         = insp.kilometrosRecorridos || tire.kilometrosRecorridos || 0;
      const mesesEnUso = insp.mesesEnUso || 1;
      const metrics    = calcCpkMetrics(costUpToInsp, km, mesesEnUso, profInicial, minDepth);

      return {
        ...insp,
        cpk:           metrics.cpk,
        cpkProyectado: metrics.cpkProyectado,
        cpt:           metrics.cpt,
        cptProyectado: metrics.cptProyectado,
      };
    });

    updateData.inspecciones = toJson(updatedInspections);
    this.triggerMarketCpkUpdate(
      updateData.marca ?? tire.marca,
      updateData.diseno ?? tire.diseno,
      updateData.dimension ?? tire.dimension,
    );
  }

  // ── 6. Persist ────────────────────────────────────────────────────────────
  if (Object.keys(updateData).length === 0) {
    return tire;
  }

  return this.prisma.tire.update({
    where: { id: tireId },
    data:  updateData,
  });
}
}