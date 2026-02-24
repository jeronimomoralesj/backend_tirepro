import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CreateTireDto } from './dto/create-tire.dto';
import { UpdateInspectionDto } from './dto/update-inspection.dto';
import { uploadFileToS3 } from './s3.service';
import * as XLSX from 'xlsx';
import { VehicleService } from 'src/vehicles/vehicle.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import { MarketDataService } from '../market-data/market-data.service';

@Injectable()
export class TireService {
  constructor(private readonly prisma: PrismaService,
    private readonly vehicleService: VehicleService, 
    private notificationsService: NotificationsService,
    private readonly marketDataService: MarketDataService,
  ) {}

  private generateRandomString(length: number): string {
    let result = "";
    const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const charactersLength = characters.length;
    for (let i = 0; i < length; i++) {
      result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
  }

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

  const company = await this.prisma.company.findUnique({
    where: { id: companyId },
  });
  if (!company) {
    throw new BadRequestException('Invalid companyId provided');
  }

  let vehicle: any = null;
  if (vehicleId) {
    vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
    });
    if (!vehicle) {
      throw new BadRequestException('Invalid vehicleId provided');
    }
  }

  const finalPlaca =
    placa && placa.trim() !== ''
      ? placa.trim().toLowerCase()
      : this.generateRandomString(8);

  const { canonicalBrand, canonicalDiseno, canonicalDimension } =
    await this.marketDataService.syncTireWithMarketData(
      marca,
      diseno ?? '',
      dimension ?? '',
    );

  const fechaInstalacionFinal =
    fechaInstalacion ? new Date(fechaInstalacion) : new Date();

  // kmInstalacion = vehicle odometer at the moment this tire was installed.
  // Used later to compute tirKm = currentVehicleKm - kmInstalacion.
  const kmInstalacion: number = vehicle ? (vehicle.kilometrajeActual || 0) : 0;

  const newTire = await (this.prisma.tire.create as any)({
    data: {
      placa: finalPlaca,
      marca: canonicalBrand,
      diseno: canonicalDiseno,
      profundidadInicial,
      dimension: canonicalDimension,
      eje,
      posicion,
      vida: Array.isArray(vida) ? vida : [],
      costo: Array.isArray(costo) ? costo : [],
      inspecciones: Array.isArray(inspecciones) ? inspecciones : [],
      primeraVida: Array.isArray(primeraVida) ? primeraVida : [],
      kilometrosRecorridos: kilometrosRecorridos ?? 0,
      eventos: Array.isArray(eventos) ? eventos : [],
      companyId,
      vehicleId: vehicleId ?? null,
      fechaInstalacion: fechaInstalacionFinal,
      diasAcumulados: 0,
      desechos: desechos ?? null,
      kmInstalacion,
    },
  });

  await this.prisma.company.update({
    where: { id: companyId },
    data: { tireCount: { increment: 1 } },
  });

  if (vehicleId) {
    await this.prisma.vehicle.update({
      where: { id: vehicleId },
      data: { tireCount: { increment: 1 } },
    });
  }

  return newTire;
}

async bulkUploadTires(file: any, companyId: string) {
  const wb = XLSX.read(file.buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows: Record<string, string>[] = XLSX.utils.sheet_to_json(sheet, {
    raw: false,
    defval: '',
  });

  const KM_POR_MES = 6000;
  const MS_POR_DIA = 1000 * 60 * 60 * 24;
  const PREMIUM_TIRE_EXPECTED_KM = 120000;
  const STANDARD_TIRE_EXPECTED_KM = 80000;
  const SIGNIFICANT_WEAR_MM = 5;
  const RECENT_REGISTRATION_DAYS = 30;
  const DEFAULT_PROFUNDIDAD_INICIAL = 22;
  const REENCAUCHE_COST = 650000;
  const FALLBACK_TIRE_PRICE = 2200000;
  const MIN_VALID_PRICE = 1000000;
  const PREMIUM_TIRE_THRESHOLD = 2100000;
  const LIMITE_LEGAL_MM = 2;

  const isFormatB = rows.length > 0 && (
    Object.keys(rows[0]).some(k =>
      k.toLowerCase().includes('numero de llanta') ||
      k.toLowerCase().includes('tipo de equipo')
    )
  );

  console.log(`📋 Detected Excel Format: ${isFormatB ? 'FORMAT B (New)' : 'FORMAT A (Original)'}`);

  const headerMap: Record<string, string> = isFormatB ? {
    'tipo de equipo': 'tipovhc',
    'placa': 'placa_vehiculo',
    'km actual': 'kilometros_vehiculo',
    'pos': 'posicion',
    '# numero de llanta': 'llanta',
    'numero de llanta': 'llanta',
    'diseño': 'diseno_original',
    'diseno': 'diseno_original',
    'marca': 'marca',
    'marca band': 'marca_banda',
    'banda': 'banda_name',
    'tipo llanta': 'eje',
    'dimensión': 'dimension',
    'dimension': 'dimension',
    'prf int': 'profundidad_int',
    'pro cent': 'profundidad_cen',
    'pro ext': 'profundidad_ext',
    'profundidad inicial': 'profundidad_inicial',
  } : {
    'llanta': 'llanta',
    'numero de llanta': 'llanta',
    'id': 'llanta',
    'placa vehiculo': 'placa_vehiculo',
    'placa': 'placa_vehiculo',
    'marca': 'marca',
    'diseno': 'diseno_original',
    'diseño': 'diseno_original',
    'dimension': 'dimension',
    'dimensión': 'dimension',
    'eje': 'eje',
    'posicion': 'posicion',
    'vida': 'vida',
    'kilometros llanta': 'kilometros_llanta',
    'kilometraje vehiculo': 'kilometros_vehiculo',
    'profundidad int': 'profundidad_int',
    'profundidad cen': 'profundidad_cen',
    'profundidad ext': 'profundidad_ext',
    'profundidad inicial': 'profundidad_inicial',
    'costo': 'costo',
    'cost': 'costo',
    'precio': 'costo',
    'costo furgon': 'costo',
    'fecha instalacion': 'fecha_instalacion',
    'imageurl': 'imageurl',
    'tipovhc': 'tipovhc',
    'tipo de vehiculo': 'tipovhc',
    'tipo vhc': 'tipovhc',
  };

  const normalize = (s: string) =>
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  const get = (row: any, header: string) => {
    const normalized = headerMap[normalize(header)] || normalize(header);
    const key = Object.keys(row).find(
      k =>
        headerMap[normalize(k)] === normalized ||
        normalize(k) === normalized,
    );
    return key ? row[key] : '';
  };

  const parseCurrency = (value: string): number => {
    if (!value) return 0;
    const cleaned = value
      .replace(/[$,\s]/g, '')
      .replace(/[^\d.]/g, '');
    const parsed = parseFloat(cleaned);
    return isNaN(parsed) ? 0 : parsed;
  };

  const generateTireId = (): string => {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
  };

  const needsIdGeneration = (id: string): boolean => {
    if (!id || !id.trim()) return true;
    const normalizedId = normalize(id);
    const invalidPatterns = ['no aplica', 'no visible', 'no space', 'nospace'];
    return invalidPatterns.some(pattern => normalizedId.includes(pattern));
  };

  const normalizeTipoVHC = (tipovhc: string): string => {
    if (!tipovhc) return '';
    const normalized = normalize(tipovhc);
    if (normalized === 'trailer') return 'trailer 3 ejes';
    if (normalized === 'cabezote') return 'cabezote 2 ejes';
    return tipovhc.trim().toLowerCase();
  };

  const fetchTirePriceFromMarketData = async (
    marca: string,
    diseno: string,
    dimension: string,
  ): Promise<number> => {
    try {
      let marketTire = await this.prisma.marketTire.findFirst({
        where: {
          brand: { equals: marca, mode: 'insensitive' },
          diseno: { equals: diseno, mode: 'insensitive' },
          dimension: { equals: dimension, mode: 'insensitive' },
        },
      });

      if (!marketTire) {
        marketTire = await this.prisma.marketTire.findFirst({
          where: {
            brand: { equals: marca, mode: 'insensitive' },
            diseno: { equals: diseno, mode: 'insensitive' },
          },
        });
      }

      if (!marketTire) {
        marketTire = await this.prisma.marketTire.findFirst({
          where: { brand: { equals: marca, mode: 'insensitive' } },
          orderBy: { updatedAt: 'desc' },
        });
      }

      if (marketTire) {
        type PriceEntry = { price: number; date: string; source?: string };
        const prices = Array.isArray(marketTire.prices)
          ? (marketTire.prices as PriceEntry[])
          : [];

        if (prices.length > 0) {
          const sortedPrices = [...prices].sort((a, b) =>
            new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime()
          );
          const latestPrice = sortedPrices[0]?.price;
          if (latestPrice && latestPrice >= MIN_VALID_PRICE) {
            return latestPrice;
          }
        }

        if (marketTire.cpk && marketTire.cpk > 0) {
          const estimatedPrice = Math.round(marketTire.cpk * STANDARD_TIRE_EXPECTED_KM);
          if (estimatedPrice >= MIN_VALID_PRICE) {
            return estimatedPrice;
          }
        }
      }

      return FALLBACK_TIRE_PRICE;
    } catch (error) {
      console.error(`❌ Error fetching market data:`, error);
      return FALLBACK_TIRE_PRICE;
    }
  };

  const tireDataMap = new Map<string, { lastVida: string; lastCosto: number }>();
  const processedIds = new Set<string>();
  const errors: string[] = [];
  const warnings: string[] = [];

  let lastSeenTipoVHC = '';
  let lastSeenPlaca = '';

  if (rows.length > 0) {
    console.log('📋 First row raw keys:', Object.keys(rows[0]));
  }

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];

    if (isFormatB) {
      const currentTipoVHC = get(row, 'tipovhc')?.trim();
      const currentPlaca = get(row, 'placa_vehiculo')?.trim();
      if (currentTipoVHC) lastSeenTipoVHC = currentTipoVHC;
      if (currentPlaca) lastSeenPlaca = currentPlaca;
    }

    const tirePlacaRaw = get(row, 'llanta')?.trim();
    let tirePlaca = '';

    if (needsIdGeneration(tirePlacaRaw)) {
      tirePlaca = generateTireId().toLowerCase();
    } else {
      tirePlaca = tirePlacaRaw.toLowerCase();
    }

    if (processedIds.has(tirePlaca)) {
      const placaVehiculoCheck = isFormatB
        ? (get(row, 'placa_vehiculo')?.trim() || lastSeenPlaca)
        : get(row, 'placa_vehiculo')?.trim();

      if (!placaVehiculoCheck) {
        errors.push(`Error: Duplicate tire ID "${tirePlaca}" found in row ${rowIndex + 2} with no vehicle context. Skipping.`);
        continue;
      }
    }

    processedIds.add(tirePlaca);

    const marca = get(row, 'marca').toLowerCase();
    let diseno = get(row, 'diseno_original').toLowerCase();
    const dimension = get(row, 'dimension').toLowerCase();
    const eje = get(row, 'eje').toLowerCase();
    const posicion = parseInt(get(row, 'posicion') || '0', 10);

    let tipovhc = isFormatB
      ? (get(row, 'tipovhc')?.trim() || lastSeenTipoVHC)
      : get(row, 'tipovhc')?.trim();
    tipovhc = normalizeTipoVHC(tipovhc);

    const profIntEarly = parseFloat(get(row, 'profundidad_int') || '0');
    const profCenEarly = parseFloat(get(row, 'profundidad_cen') || '0');
    const profExtEarly = parseFloat(get(row, 'profundidad_ext') || '0');

    let profundidadInicial = parseFloat(get(row, 'profundidad_inicial') || '0');

    if (!profundidadInicial || profundidadInicial <= 0) {
      const maxObservedDepth = Math.max(profIntEarly, profCenEarly, profExtEarly);
      if (maxObservedDepth > 0) {
        profundidadInicial = maxObservedDepth > DEFAULT_PROFUNDIDAD_INICIAL
          ? maxObservedDepth + 1
          : DEFAULT_PROFUNDIDAD_INICIAL;
        warnings.push(`Row ${rowIndex + 2}: profundidad inicial inferred as ${profundidadInicial}mm`);
      } else {
        profundidadInicial = DEFAULT_PROFUNDIDAD_INICIAL;
        warnings.push(`Row ${rowIndex + 2}: Using default profundidad inicial: ${DEFAULT_PROFUNDIDAD_INICIAL}mm`);
      }
    }

    let vidaValor = '';
    let needsReencauche = false;
    let bandaName = '';

    if (isFormatB) {
      const marcaBanda = normalize(get(row, 'marca_banda'));
      bandaName = get(row, 'banda_name').toLowerCase();
      if (marcaBanda.includes('reencauche') || marcaBanda.includes('rencauche')) {
        vidaValor = 'nueva';
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

    let placaVehiculo = isFormatB
      ? (get(row, 'placa_vehiculo')?.trim() || lastSeenPlaca)
      : get(row, 'placa_vehiculo')?.trim();
    placaVehiculo = placaVehiculo?.toLowerCase();

    const kilometrosVehiculo = parseFloat(get(row, 'kilometros_vehiculo') || '0');

    let vehicle: any = null;

    if (placaVehiculo) {
      vehicle = await this.prisma.vehicle.findFirst({
        where: { placa: placaVehiculo },
      });

      if (!vehicle) {
        vehicle = await this.vehicleService.createVehicle({
          placa: placaVehiculo,
          kilometrajeActual: kilometrosVehiculo,
          carga: '',
          pesoCarga: 0,
          tipovhc,
          companyId,
          cliente: '',
        });
      } else if (kilometrosVehiculo > (vehicle.kilometrajeActual || 0)) {
        await this.vehicleService.updateKilometraje(vehicle.id, kilometrosVehiculo);
        vehicle.kilometrajeActual = kilometrosVehiculo;
      }
    }

    if (vehicle && tipovhc && !vehicle.tipovhc) {
      await this.prisma.vehicle.update({
        where: { id: vehicle.id },
        data: { tipovhc },
      });
      vehicle.tipovhc = tipovhc;
    }

    const { canonicalBrand, canonicalDiseno, canonicalDimension } =
      await this.marketDataService.syncTireWithMarketData(marca, diseno, dimension);

    const finalMarca = canonicalBrand;
    const finalDiseno = canonicalDiseno;
    const finalDimension = canonicalDimension;
    diseno = finalDiseno;

    const fechaInstalacionRaw = get(row, 'fecha_instalacion');
    const fechaInstalacion = fechaInstalacionRaw
      ? new Date(fechaInstalacionRaw)
      : new Date();

    const costoRaw = get(row, 'costo');
    let costoCell = parseCurrency(costoRaw);

    if (costoCell <= 0) {
      costoCell = await fetchTirePriceFromMarketData(finalMarca, finalDiseno, finalDimension);
      warnings.push(`Row ${rowIndex + 2}: Cost fetched from market data: $${costoCell}`);
    }

    const profInt = profIntEarly;
    const profCen = profCenEarly;
    const profExt = profExtEarly;
    const hasInspection = profInt > 0 || profCen > 0 || profExt > 0;

    const minDepth = hasInspection ? Math.min(profInt, profCen, profExt) : 0;
    const mmWorn = profundidadInicial - minDepth;
    const usableDepth = profundidadInicial - LIMITE_LEGAL_MM;

    const isPremiumTire = costoCell >= PREMIUM_TIRE_THRESHOLD;
    const kmLlantaExcel = parseFloat(get(row, 'kilometros_llanta') || '0');

    const now = new Date();
    const tempDiasEnUso = Math.max(
      Math.floor((now.getTime() - fechaInstalacion.getTime()) / (1000 * 60 * 60 * 24)),
      1,
    );

    // ─── KM ESTIMATION ───────────────────────────────────────────────────────
    // Priority: (1) explicit km from excel, (2) vehicle odometer km, (3) wear-based, (4) time-based
    let kilometrosEstimados = 0;
    let shouldEstimateTime = false;

    if (kmLlantaExcel > 0) {
      // Explicit tire km provided — always trust this first
      kilometrosEstimados = kmLlantaExcel;
    } else if (kilometrosVehiculo > 0) {
      // Vehicle odometer provided — use it directly as the tire's km base
      kilometrosEstimados = kilometrosVehiculo;
    } else if (hasInspection && mmWorn > 0 && usableDepth > 0) {
      // Wear-based estimation (no km data at all)
      const expectedLifetimeKm = isPremiumTire ? PREMIUM_TIRE_EXPECTED_KM : STANDARD_TIRE_EXPECTED_KM;
      const kmPerMm = expectedLifetimeKm / usableDepth;
      kilometrosEstimados = Math.round(kmPerMm * mmWorn);
      shouldEstimateTime = true;
      warnings.push(`Row ${rowIndex + 2}: KM estimated from wear — ${kilometrosEstimados} km`);
    } else {
      // Time-based fallback (last resort)
      kilometrosEstimados = Math.round((tempDiasEnUso / 30) * KM_POR_MES);
    }

    let diasEnUso = tempDiasEnUso;
    if (shouldEstimateTime && tempDiasEnUso < RECENT_REGISTRATION_DAYS && kilometrosEstimados > 0) {
      const kmPerDay = KM_POR_MES / 30;
      diasEnUso = Math.max(Math.round(kilometrosEstimados / kmPerDay), 1);
      warnings.push(`Row ${rowIndex + 2}: Time estimated from kilometers - ${diasEnUso} days`);
    }

    const mesesEnUso = diasEnUso / 30;

    // ─── MATCH EXISTING TIRE ─────────────────────────────────────────────────
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

    // ─── BRANCH: EXISTING TIRE ───────────────────────────────────────────────
    if (existingTireMatch) {
      if (hasInspection) {
        const existingInspections = Array.isArray(existingTireMatch.inspecciones)
          ? existingTireMatch.inspecciones
          : [];

        // Use whichever km is larger: existing accumulated or this row's value
        const existingKm = existingTireMatch.kilometrosRecorridos || 0;
        const kmForInspection = Math.max(kilometrosEstimados, existingKm);

        // CPK = total cost / total km
        const totalCostExisting = Array.isArray(existingTireMatch.costo)
          ? existingTireMatch.costo.reduce((sum: number, c: any) => sum + (c?.valor || 0), 0)
          : 0;

        const cpk = kmForInspection > 0 ? totalCostExisting / kmForInspection : 0;
        const cpt = mesesEnUso > 0 ? totalCostExisting / mesesEnUso : 0;

        const desgasteExisting = (existingTireMatch.profundidadInicial || profundidadInicial) - minDepth;
        let projectedKmExisting = 0;
        if (desgasteExisting > 0 && kmForInspection > 0) {
          const kmPerMm = kmForInspection / desgasteExisting;
          const mmLeft = Math.max(minDepth - LIMITE_LEGAL_MM, 0);
          projectedKmExisting = kmForInspection + kmPerMm * mmLeft;
        }

        const projectedMonthsExisting = projectedKmExisting / KM_POR_MES;
        const cpkProyectado = projectedKmExisting > 0 ? totalCostExisting / projectedKmExisting : 0;
        const cptProyectado = projectedMonthsExisting > 0 ? totalCostExisting / projectedMonthsExisting : 0;

        const newInspection = {
          fecha: fechaInstalacion.toISOString(),
          profundidadInt: profInt,
          profundidadCen: profCen,
          profundidadExt: profExt,
          diasEnUso,
          mesesEnUso,
          // Accumulated km on the tire at the moment of this inspection
          kilometrosRecorridos: kmForInspection,
          // Vehicle odometer at the moment of this inspection (0 if no vehicle linked)
          kmActualVehiculo: kilometrosVehiculo || 0,
          cpk,
          cpkProyectado,
          cpt,
          cptProyectado,
          imageUrl: get(row, 'imageurl') || '',
        };

        const sortedInspecciones = [...existingInspections, newInspection].sort((a: any, b: any) => {
          const minA = Math.min(a.profundidadInt ?? Infinity, a.profundidadCen ?? Infinity, a.profundidadExt ?? Infinity);
          const minB = Math.min(b.profundidadInt ?? Infinity, b.profundidadCen ?? Infinity, b.profundidadExt ?? Infinity);
          return minB - minA;
        });

        await this.prisma.tire.update({
          where: { id: existingTireMatch.id },
          data: {
            inspecciones: sortedInspecciones,
            kilometrosRecorridos: kmForInspection,
            diasAcumulados: diasEnUso,
          },
        });

        this.marketDataService.updateMarketCpkFromInspection(
          existingTireMatch.marca,
          existingTireMatch.diseno,
          existingTireMatch.dimension,
        ).catch((err) => console.warn(`Market CPK update failed: ${err.message}`));
      }

    } else {
      // ─── NEW TIRE ─────────────────────────────────────────────────────────
      const existingByPlaca = await this.prisma.tire.findFirst({
        where: { placa: tirePlaca },
      });
      if (existingByPlaca) {
        errors.push(`Error: Tire ID "${tirePlaca}" already exists (row ${rowIndex + 2}). Skipping.`);
        continue;
      }

      const costosActuales = costoCell > 0
        ? [{ fecha: now.toISOString(), valor: costoCell }]
        : [];

      const totalCost = costosActuales.reduce(
        (sum: number, c: any) => sum + (typeof c?.valor === 'number' ? c.valor : 0),
        0,
      );

      const vidaArray = vidaValor
        ? [{ fecha: now.toISOString(), valor: vidaValor }]
        : [];

      const tire = await (this.prisma.tire.create as any)({
        data: {
          placa: tirePlaca,
          marca: finalMarca,
          diseno: finalDiseno,
          dimension: finalDimension,
          eje,
          posicion,
          profundidadInicial,
          companyId,
          vehicleId: vehicle?.id ?? null,
          fechaInstalacion,
          vida: vidaArray,
          costo: costosActuales,
          inspecciones: [],
          eventos: [],
          // Vehicle odometer at install time — used later to compute tire km accurately
          kmInstalacion: 0,
        },
      });

      await this.prisma.company.update({
        where: { id: companyId },
        data: { tireCount: { increment: 1 } },
      });

      if (vehicle) {
        await this.prisma.vehicle.update({
          where: { id: vehicle.id },
          data: { tireCount: { increment: 1 } },
        });
      }

      if (hasInspection) {
        const cpk = kilometrosEstimados > 0 ? totalCost / kilometrosEstimados : 0;
        const cpt = mesesEnUso > 0 ? totalCost / mesesEnUso : 0;
        const desgaste = profundidadInicial - minDepth;

        let projectedKm = 0;
        if (desgaste > 0 && kilometrosEstimados > 0) {
          const kmPerMm = kilometrosEstimados / desgaste;
          const mmLeft = Math.max(minDepth - LIMITE_LEGAL_MM, 0);
          projectedKm = kilometrosEstimados + kmPerMm * mmLeft;
        }

        const projectedMonths = projectedKm / KM_POR_MES;
        const cpkProyectado = projectedKm > 0 ? totalCost / projectedKm : 0;
        const cptProyectado = projectedMonths > 0 ? totalCost / projectedMonths : 0;

        const inspecciones = [{
          fecha: now.toISOString(),
          profundidadInt: profInt,
          profundidadCen: profCen,
          profundidadExt: profExt,
          diasEnUso,
          mesesEnUso,
          // Accumulated km on the tire at the moment of this inspection
          kilometrosRecorridos: kilometrosEstimados,
          // Vehicle odometer at the moment of this inspection (0 if no vehicle linked)
          kmActualVehiculo: kilometrosVehiculo || 0,
          cpk,
          cpkProyectado,
          cpt,
          cptProyectado,
          imageUrl: get(row, 'imageurl') || '',
        }];

        await this.prisma.tire.update({
          where: { id: tire.id },
          data: {
            costo: costosActuales,
            vida: vidaArray,
            inspecciones,
            kilometrosRecorridos: kilometrosEstimados,
            diasAcumulados: diasEnUso,
          },
        });
      } else {
        await this.prisma.tire.update({
          where: { id: tire.id },
          data: {
            costo: costosActuales,
            vida: vidaArray,
            kilometrosRecorridos: kilometrosEstimados,
            diasAcumulados: diasEnUso,
          },
        });
      }

      if (hasInspection) {
        this.marketDataService.updateMarketCpkFromInspection(
          finalMarca, finalDiseno, finalDimension,
        ).catch((err) => console.warn(`Market CPK update failed: ${err.message}`));
      }

      if (needsReencauche) {
        try {
          await this.updateVida(
            tire.id,
            'reencauche1',
            bandaName || finalDiseno,
            REENCAUCHE_COST,
            profundidadInicial,
            undefined,
          );
        } catch (error) {
          errors.push(`Error performing reencauche for tire ${tirePlaca} (row ${rowIndex + 2}): ${error.message}`);
        }
      }
    }

    const lastData = tireDataMap.get(tirePlaca) || { lastVida: '', lastCosto: -1 };
    lastData.lastVida = vidaValor;
    tireDataMap.set(tirePlaca, lastData);
  }

  const successCount = processedIds.size;
  const errorCount = errors.length;
  const warningCount = warnings.length;

  let message = `Carga masiva completada. ${successCount} llantas procesadas exitosamente.`;
  if (warningCount > 0) message += ` ${warningCount} advertencias encontradas.`;
  if (errorCount > 0) message += ` ${errorCount} errores encontrados.`;

  return {
    message,
    success: successCount,
    errors: errorCount,
    warnings: warningCount,
    details: { errors, warnings },
  };
}

async findTiresByCompany(companyId: string) {
    return await this.prisma.tire.findMany({ where: { companyId } });
}

async findTiresByVehicle(vehicleId: string) {
    if (!vehicleId) throw new BadRequestException('vehicleId is required');
    return await this.prisma.tire.findMany({ where: { vehicleId } });
}

async updateInspection(tireId: string, updateDto: UpdateInspectionDto) {
  // ── Guard: all-zero depths means nothing to record ──────────────────────
  if (
    updateDto.profundidadInt === 0 &&
    updateDto.profundidadCen === 0 &&
    updateDto.profundidadExt === 0
  ) {
    return this.prisma.tire.findUnique({ where: { id: tireId } });
  }

  const MS_POR_DIA = 1000 * 60 * 60 * 24;
  const KM_POR_MES = 6000;
  const LIMITE_LEGAL_MM = 2;

  // ── Fetch tire + vehicle ─────────────────────────────────────────────────
  const tire = await this.prisma.tire.findUnique({ where: { id: tireId } });
  if (!tire) throw new BadRequestException('Tire not found');
  if (!tire.vehicleId) throw new BadRequestException('Tire is not associated with a vehicle');

  const vehicle = await this.prisma.vehicle.findUnique({ where: { id: tire.vehicleId } });
  if (!vehicle) throw new BadRequestException('Vehicle not found for tire');

  const newVehicleKm = updateDto.newKilometraje || 0;
  const odometerProvided = newVehicleKm > 0;
  const priorTireKm = tire.kilometrosRecorridos || 0;

  // ── Km calculation ───────────────────────────────────────────────────────
  //
  // Since we have no kmInstalacion column, we derive the previous vehicle km
  // from the last inspection's kmActualVehiculo field (stored in the JSON).
  // This gives us a reliable delta per inspection session without schema changes.
  //
  // Formula: tireKm = priorTireKm + (newVehicleKm - lastKnownVehicleKm)
  //
  let kilometrosRecorridos: number;

  if (odometerProvided) {
    const inspecciones = Array.isArray(tire.inspecciones) ? tire.inspecciones as any[] : [];

    // Find the vehicle km recorded at the last inspection
    // If no prior inspection exists, use the current vehicle odometer as baseline
    // (meaning this is the first inspection — delta will be 0, tire km stays at priorTireKm)
    let lastKnownVehicleKm: number;

    if (inspecciones.length > 0) {
      // Sort by fecha descending and take the most recent kmActualVehiculo
      const sorted = [...inspecciones].sort(
        (a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime()
      );
      lastKnownVehicleKm = sorted[0]?.kmActualVehiculo ?? vehicle.kilometrajeActual ?? 0;
    } else {
      // No prior inspections — use current vehicle odometer as baseline so
      // the first inspection contributes 0 delta (we don't know how long
      // the tire has been on, so we don't guess)
      lastKnownVehicleKm = vehicle.kilometrajeActual ?? 0;
    }

    const vehicleDelta = Math.max(newVehicleKm - lastKnownVehicleKm, 0);
    kilometrosRecorridos = priorTireKm + vehicleDelta;

  } else {
    // No odometer provided — preserve existing tire km unchanged
    kilometrosRecorridos = priorTireKm;
  }

  // Persist updated tire km
  await this.prisma.tire.update({
    where: { id: tireId },
    data: { kilometrosRecorridos },
  });

  // ── Time in use ──────────────────────────────────────────────────────────
  const now = new Date();
  const fechaInstalacion = tire.fechaInstalacion ?? now;
  const diasEnUso = Math.max(
    Math.floor((now.getTime() - new Date(fechaInstalacion).getTime()) / MS_POR_DIA),
    1,
  );
  const mesesEnUso = diasEnUso / 30;

  // ── Depth values ─────────────────────────────────────────────────────────
  const minDepth = Math.min(
    updateDto.profundidadInt,
    updateDto.profundidadCen,
    updateDto.profundidadExt,
  );
  const profundidadInicial = tire.profundidadInicial;
  const mmWorn = profundidadInicial - minDepth;

  // If km ended up 0 fall back to time-based estimate so CPK never divides by zero
  const effectiveKm = kilometrosRecorridos > 0
    ? kilometrosRecorridos
    : Math.round(mesesEnUso * KM_POR_MES);

  // ── Total cost ───────────────────────────────────────────────────────────
  const totalCost = Array.isArray(tire.costo)
    ? tire.costo.reduce((sum: number, entry: any) => sum + (entry?.valor || 0), 0)
    : 0;

  // ── CPK ──────────────────────────────────────────────────────────────────
  const cpk = effectiveKm > 0 ? totalCost / effectiveKm : 0;
  const cpt = mesesEnUso > 0 ? totalCost / mesesEnUso : 0;

  // ── Projected life ───────────────────────────────────────────────────────
  let projectedKm = 0;
  if (mmWorn > 0 && effectiveKm > 0) {
    const kmPerMm = effectiveKm / mmWorn;
    const mmLeft = Math.max(minDepth - LIMITE_LEGAL_MM, 0);
    projectedKm = effectiveKm + kmPerMm * mmLeft;
  }

  const projectedMonths = projectedKm / KM_POR_MES;
  const cpkProyectado = projectedKm > 0 ? totalCost / projectedKm : 0;
  const cptProyectado = projectedMonths > 0 ? totalCost / projectedMonths : 0;

  // ── Image upload ─────────────────────────────────────────────────────────
  let finalImageUrl = updateDto.imageUrl;
  if (updateDto.imageUrl?.startsWith('data:')) {
    const base64Data = updateDto.imageUrl.split(',')[1];
    const fileBuffer = Buffer.from(base64Data, 'base64');
    const fileName = `tire-inspections/${tireId}-${Date.now()}.jpg`;
    finalImageUrl = await uploadFileToS3(fileBuffer, fileName, 'image/jpeg');
  }

  // ── Build and save new inspection ────────────────────────────────────────
  const currentInspections = Array.isArray(tire.inspecciones)
    ? tire.inspecciones as any[]
    : [];

  const newInspection = {
    profundidadInt: updateDto.profundidadInt,
    profundidadCen: updateDto.profundidadCen,
    profundidadExt: updateDto.profundidadExt,
    imageUrl: finalImageUrl,
    fecha: now.toISOString(),
    diasEnUso,
    mesesEnUso,
    kilometrosRecorridos,
    kmEfectivos: effectiveKm,
    // ← this is the key field — used by the NEXT inspection to compute delta
    kmActualVehiculo: odometerProvided ? newVehicleKm : (vehicle.kilometrajeActual || 0),
    cpk,
    cpkProyectado,
    cpt,
    cptProyectado,
  };

  const finalTire = await this.prisma.tire.update({
    where: { id: tireId },
    data: {
      inspecciones: [...currentInspections, newInspection],
      diasAcumulados: diasEnUso,
    },
  });

  // ── Update vehicle odometer ───────────────────────────────────────────────
  if (odometerProvided) {
    await this.prisma.vehicle.update({
      where: { id: vehicle.id },
      data: { kilometrajeActual: newVehicleKm },
    });
  }

  // ── Notifications ─────────────────────────────────────────────────────────
  await this.notificationsService.deleteByTire(finalTire.id);

  const analysis = this.analyzeTire(finalTire);
  const recommendation = analysis?.recomendaciones?.[0] ?? '';

  if (recommendation.startsWith('🔴') || recommendation.startsWith('🟡')) {
    await this.notificationsService.createNotification({
      title: `Llantas - ${recommendation.includes('🔴') ? 'Crítico' : 'Precaución'}`,
      message: recommendation,
      type: recommendation.includes('🔴') ? 'critical' : 'warning',
      tireId: finalTire.id,
      vehicleId: finalTire.vehicleId ?? undefined,
      companyId: finalTire.companyId ?? undefined,
    });
  }

  // ── Market data CPK update (fire-and-forget) ──────────────────────────────
  this.marketDataService.updateMarketCpkFromInspection(
    finalTire.marca,
    finalTire.diseno,
    finalTire.dimension,
  ).catch((err) => console.warn(`Market CPK update failed silently: ${err.message}`));

  return finalTire;
}
  
async updateVida(
  tireId: string,
  newValor: string | undefined,
  banda?: string,
  costo?: number,
  profundidadInicial?: number | string,
  desechoData?: {
    causales: string;
    milimetrosDesechados: number;
  }
) {
  if (!newValor) {
    throw new BadRequestException(`El campo 'valor' es obligatorio`);
  }

  const normalizedValor = newValor.toLowerCase();
  const allowed = ['nueva', 'reencauche1', 'reencauche2', 'reencauche3', 'fin'];
  const newIndex = allowed.indexOf(normalizedValor);

  if (newIndex < 0) {
    throw new BadRequestException(`"${newValor}" no es un valor válido`);
  }

  let parsedProfundidad: number | null = null;

  if (normalizedValor !== 'fin') {
    if (
      profundidadInicial === undefined ||
      profundidadInicial === null ||
      (typeof profundidadInicial === 'string' && profundidadInicial.trim() === '')
    ) {
      throw new BadRequestException("La profundidad inicial es requerida para este valor de vida.");
    }

    parsedProfundidad =
      typeof profundidadInicial === 'string'
        ? parseFloat(profundidadInicial)
        : Number(profundidadInicial);

    if (isNaN(parsedProfundidad) || parsedProfundidad <= 0) {
      throw new BadRequestException("La profundidad inicial debe ser un número mayor a 0.");
    }
  }

  const tire = await this.prisma.tire.findUnique({ where: { id: tireId } });
  if (!tire) throw new BadRequestException('Tire not found');

  const vidaArray = (Array.isArray(tire.vida) ? tire.vida : []) as Array<{
    fecha: string;
    valor: string;
  }>;

  const lastEntry = vidaArray.length ? vidaArray[vidaArray.length - 1] : null;
  if (lastEntry) {
    const lastIndex = allowed.indexOf(lastEntry.valor.toLowerCase());
    if (lastIndex < 0) throw new BadRequestException('Último valor de vida inválido');
    if (newIndex <= lastIndex) {
      throw new BadRequestException(
        `Debe avanzar en la secuencia. Último valor: "${lastEntry.valor}".`
      );
    }
  }

  const updateData: any = {
    vida: [
      ...vidaArray,
      { fecha: new Date().toISOString(), valor: normalizedValor },
    ],
  };

  if (normalizedValor !== 'fin' && parsedProfundidad !== null) {
    updateData.profundidadInicial = parsedProfundidad;
  }

  if (banda?.trim()) {
    updateData.diseno = banda.trim();
  }

  if (normalizedValor.startsWith('reencauche')) {
    const existingCosto = Array.isArray(tire.costo) ? tire.costo : [];
    let costoValue = 0;

    if (typeof costo === 'number' && costo > 0) {
      costoValue = costo;
    } else if (normalizedValor === 'reencauche1' && existingCosto.length) {
      const lastC = existingCosto[existingCosto.length - 1] as any;
      costoValue = typeof lastC.valor === 'number' ? lastC.valor : 0;
    }

    if (costoValue > 0) {
      updateData.costo = [
        ...existingCosto,
        { fecha: new Date().toISOString(), valor: costoValue },
      ];
    }
  }

  if (normalizedValor === 'reencauche1') {
    let cpk = 0;
    if (Array.isArray(tire.inspecciones) && tire.inspecciones.length) {
      const insps = [...tire.inspecciones] as Array<{ fecha: string; cpk?: number }>;
      insps.sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime());
      cpk = insps[0]?.cpk ?? 0;
    }

    const designValue = banda?.trim() || tire.diseno;
    const costoForPrimera =
      typeof costo === 'number' && costo > 0
        ? costo
        : Array.isArray(tire.costo) && tire.costo.length
        ? ((tire.costo[tire.costo.length - 1] as any).valor as number) || 0
        : 0;

    updateData.primeraVida = [
      {
        diseno: designValue,
        cpk,
        costo: costoForPrimera,
        kilometros: tire.kilometrosRecorridos || 0,
      },
    ];
  }

  if (normalizedValor === 'fin') {
    updateData.vehicleId = null;

    if (tire.vehicleId) {
      await this.prisma.vehicle.update({
        where: { id: tire.vehicleId },
        data: { tireCount: { decrement: 1 } },
      });
    }

    if (!desechoData || !desechoData.causales || desechoData.milimetrosDesechados === undefined) {
      throw new BadRequestException('Información de desecho incompleta');
    }

    const profundidad = tire.profundidadInicial || 0;
    let lastCosto = 0;
    if (Array.isArray(tire.costo) && tire.costo.length > 0) {
      const lastEntry = tire.costo[tire.costo.length - 1] as any;
      lastCosto = typeof lastEntry.valor === 'number' ? lastEntry.valor : 0;
    }

    const cpk = profundidad > 0 ? lastCosto / profundidad : 0;
    const remanente = cpk * desechoData.milimetrosDesechados;

    updateData.desechos = {
      causales: desechoData.causales,
      milimetrosDesechados: desechoData.milimetrosDesechados,
      remanente: Number(remanente.toFixed(2)),
      fecha: new Date().toISOString(),
    };
  }

  const finalTire = await this.prisma.tire.update({
    where: { id: tireId },
    data: updateData,
  });

  await this.notificationsService.deleteByTire(finalTire.id);

  return finalTire;
}

async updateEvento(tireId: string, newValor: string) {
  const tire = await this.prisma.tire.findUnique({ where: { id: tireId } });
  if (!tire) throw new BadRequestException('Tire not found');

  const eventosArray: { valor: string; fecha: string }[] = Array.isArray(tire.eventos)
    ? tire.eventos as any
    : [];

  const updatedEventos = [...eventosArray, { valor: newValor, fecha: new Date().toISOString() }];

  return this.prisma.tire.update({
    where: { id: tireId },
    data: { eventos: updatedEventos },
  });
}

async updatePositions(placa: string, updates: { [position: string]: string | string[] }) {
  const vehicle = await this.prisma.vehicle.findFirst({ where: { placa } });
  if (!vehicle) throw new BadRequestException('Vehicle not found for the given placa');

  await this.prisma.tire.updateMany({
    where: { vehicleId: vehicle.id, placa },
    data: { posicion: 0 },
  });

  for (const pos in updates) {
    const tireIds = Array.isArray(updates[pos]) ? updates[pos] : [updates[pos]];
    for (const tireId of tireIds) {
      const tire = await this.prisma.tire.findUnique({ where: { id: tireId } });
      if (!tire) throw new BadRequestException(`Tire with id ${tireId} not found`);
      if (tire.vehicleId !== vehicle.id) {
        throw new BadRequestException(`Tire with id ${tireId} does not belong to vehicle with plate ${placa}`);
      }
      await this.prisma.tire.update({
        where: { id: tireId },
        data: { posicion: pos === '0' ? 0 : parseInt(pos, 10) },
      });
    }
  }

  return { message: 'Positions updated successfully' };
}

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

private analyzeTire(tire: any) {
  if (!tire.inspecciones || !Array.isArray(tire.inspecciones) || tire.inspecciones.length === 0) {
    return {
      id: tire.id,
      posicion: tire.posicion,
      profundidadActual: null,
      inspecciones: [],
      recomendaciones: [
        "🔴 Inspección requerida: No se han registrado inspecciones. Realizar una evaluación inmediata."
      ],
    };
  }

  const lastInspections = [...tire.inspecciones]
    .sort((a: any, b: any) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime())
    .slice(0, 3);
  const latest = lastInspections[0];

  const pInt = Number(latest.profundidadInt) || 0;
  const pCen = Number(latest.profundidadCen) || 0;
  const pExt = Number(latest.profundidadExt) || 0;
  const profundidadActual = (pInt + pCen + pExt) / 3;

  const presion = tire.presion?.[tire.presion.length - 1]?.value;
  const cpk = tire.cpk?.[tire.cpk.length - 1]?.value;
  const delta1 = Math.abs(pInt - pCen);
  const delta2 = Math.abs(pCen - pExt);
  const delta3 = Math.abs(pInt - pExt);

  let recomendacion = "";

  if (profundidadActual <= 2) {
    recomendacion = "🔴 Cambio inmediato: Desgaste crítico. Reemplazo urgente.";
  } else if (delta1 > 3 || delta2 > 3 || delta3 > 3) {
    recomendacion = "🟡 Desgaste irregular: Diferencias notables entre zonas. Revisar alineación o presión.";
  } else if (cpk && cpk < 5) {
    recomendacion = "🔴 CPK muy bajo: Alto costo por kilómetro. Evaluar desempeño de la llanta.";
  } else if (presion != null && (presion < 100 || presion > 130)) {
    recomendacion = `🟡 Presión fuera de rango: Actual: ${presion} PSI. Ajustar conforme a especificación.`;
  } else if (profundidadActual <= 4) {
    recomendacion = "🟡 Revisión frecuente: La profundidad está bajando. Monitorear en próximas inspecciones.";
  } else {
    recomendacion = "🟢 Buen estado: Sin hallazgos relevantes en esta inspección.";
  }

  return {
    id: tire.id,
    posicion: tire.posicion,
    profundidadActual,
    inspecciones: lastInspections,
    recomendaciones: [recomendacion],
    desechos: tire.desechos ?? null,
  };
}

async removeInspection(tireId: string, fecha: string) {
  const tire = await this.prisma.tire.findUnique({ where: { id: tireId } });
  if (!tire) throw new BadRequestException('Tire not found');

  const inspeccionesArray = Array.isArray(tire.inspecciones)
    ? tire.inspecciones as Array<{ fecha: string }>
    : [];

  const updated = inspeccionesArray.filter(i => i.fecha !== fecha);

  await this.prisma.tire.update({
    where: { id: tireId },
    data: { inspecciones: updated },
  });

  return { message: 'Inspección eliminada' };
}

async findAllTires() {
    return await this.prisma.tire.findMany();
}
  
async assignTiresToVehicle(vehiclePlaca: string, tireIds: string[]) {
  const vehicle = await this.prisma.vehicle.findFirst({ where: { placa: vehiclePlaca } });
  if (!vehicle) throw new BadRequestException('Vehicle not found');

  // Record the vehicle odometer at the moment each tire is assigned.
  // This allows us to compute tire km as: currentVehicleKm - kmInstalacion.
  const kmInstalacion = vehicle.kilometrajeActual || 0;

  await (this.prisma.tire.updateMany as any)({
    where: { id: { in: tireIds } },
    data: {
      vehicleId: vehicle.id,
      kmInstalacion,
    },
  });

  await this.prisma.vehicle.update({
    where: { id: vehicle.id },
    data: { tireCount: { increment: tireIds.length } },
  });

  return { message: 'Tires assigned successfully', count: tireIds.length };
}

async unassignTiresFromVehicle(tireIds: string[]) {
  const tires = await this.prisma.tire.findMany({ where: { id: { in: tireIds } } });

  const vehicleIds = [...new Set(tires.map(t => t.vehicleId).filter((id): id is string => id !== null))];
  for (const vid of vehicleIds) {
    const count = tires.filter(t => t.vehicleId === vid).length;
    await this.prisma.vehicle.update({
      where: { id: vid },
      data: { tireCount: { decrement: count } },
    });
  }

  await this.prisma.tire.updateMany({
    where: { id: { in: tireIds } },
    data: { vehicleId: null, posicion: 0 },
  });

  return { message: 'Tires unassigned successfully', count: tireIds.length };
}
}