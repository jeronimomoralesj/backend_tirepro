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

  // Helper function to generate a random string of given length.
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
    fechaInstalacion, // 🆕 opcional
  } = createTireDto;

  // =========================
  // VALIDAR EMPRESA
  // =========================
  const company = await this.prisma.company.findUnique({
    where: { id: companyId },
  });
  if (!company) {
    throw new BadRequestException('Invalid companyId provided');
  }

  // =========================
  // VALIDAR VEHÍCULO (SI APLICA)
  // =========================
  let vehicle: any = null;
  if (vehicleId) {
    vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
    });
    if (!vehicle) {
      throw new BadRequestException('Invalid vehicleId provided');
    }
  }

  // =========================
  // PLACA FINAL
  // =========================
  const finalPlaca =
    placa && placa.trim() !== ''
      ? placa.trim().toLowerCase()
      : this.generateRandomString(8);

  // =========================
// SYNC WITH MARKET DATA
// =========================
const { canonicalBrand, canonicalDiseno, canonicalDimension } =
  await this.marketDataService.syncTireWithMarketData(
    marca,
    diseno ?? '',
    dimension ?? '',
  );

  // =========================
  // FECHA DE INSTALACIÓN
  // =========================
  const fechaInstalacionFinal =
    fechaInstalacion ? new Date(fechaInstalacion) : new Date();

  // =========================
  // CREAR LLANTA
  // =========================
  const newTire = await this.prisma.tire.create({
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

      // 🆕 CAMPOS DE TIEMPO
      fechaInstalacion: fechaInstalacionFinal,
      diasAcumulados: 0,

      desechos: desechos ?? null,
    },
  });

  // =========================
  // CONTADORES
  // =========================
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

  // =========================
  // FORMAT DETECTION
  // =========================
  const isFormatB = rows.length > 0 && (
    Object.keys(rows[0]).some(k => 
      k.toLowerCase().includes('numero de llanta') || 
      k.toLowerCase().includes('tipo de equipo')
    )
  );

  console.log(`📋 Detected Excel Format: ${isFormatB ? 'FORMAT B (New)' : 'FORMAT A (Original)'}`);

  // =========================
  // HEADER MAPPING
  // =========================
  const headerMap: Record<string, string> = isFormatB ? {
    // FORMAT B mappings
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
    // FORMAT A mappings (original)
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
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
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

  // Check if tire ID is invalid and needs generation
  const needsIdGeneration = (id: string): boolean => {
    if (!id || !id.trim()) return true;
    const normalizedId = normalize(id);
    const invalidPatterns = ['no aplica', 'no visible', 'no space', 'nospace'];
    return invalidPatterns.some(pattern => normalizedId.includes(pattern));
  };

  // Normalize tipovhc to highest variant if incomplete
  const normalizeTipoVHC = (tipovhc: string): string => {
    if (!tipovhc) return '';
    const normalized = normalize(tipovhc);
    
    if (normalized === 'trailer') {
      console.log(`🔄 Normalized 'trailer' to 'trailer 3 ejes'`);
      return 'trailer 3 ejes';
    }
    
    if (normalized === 'cabezote') {
      console.log(`🔄 Normalized 'cabezote' to 'cabezote 2 ejes'`);
      return 'cabezote 2 ejes';
    }
    
    return tipovhc.trim().toLowerCase();
  };

  // =========================
  // FETCH PRICE FROM MARKET DATA DB
  // =========================
  const fetchTirePriceFromMarketData = async (
    marca: string, 
    diseno: string, 
    dimension: string
  ): Promise<number> => {
    try {
      console.log(`💰 Searching market data for: ${marca} ${diseno} ${dimension}`);
      
      // Try exact match first
      let marketTire = await this.prisma.marketTire.findFirst({
        where: {
          brand: { equals: marca, mode: 'insensitive' },
          diseno: { equals: diseno, mode: 'insensitive' },
          dimension: { equals: dimension, mode: 'insensitive' },
        },
      });

      // If no exact match, try without dimension
      if (!marketTire) {
        console.log(`🔍 No exact match found, trying without dimension...`);
        marketTire = await this.prisma.marketTire.findFirst({
          where: {
            brand: { equals: marca, mode: 'insensitive' },
            diseno: { equals: diseno, mode: 'insensitive' },
          },
        });
      }

      // If still no match, try just brand
      if (!marketTire) {
        console.log(`🔍 No match with diseno, trying just brand...`);
        marketTire = await this.prisma.marketTire.findFirst({
          where: {
            brand: { equals: marca, mode: 'insensitive' },
          },
          orderBy: {
            updatedAt: 'desc', // Get most recent price
          },
        });
      }

      if (marketTire) {
        // Define the price entry type
        type PriceEntry = {
          price: number;
          date: string;
          source?: string;
        };

        // Parse prices JSON array with proper typing
        const prices = Array.isArray(marketTire.prices) 
          ? (marketTire.prices as PriceEntry[])
          : [];
        
        if (prices.length > 0) {
          // Get the most recent price
          const sortedPrices = [...prices].sort((a, b) => {
            const dateA = new Date(a.date || 0).getTime();
            const dateB = new Date(b.date || 0).getTime();
            return dateB - dateA; // Most recent first
          });
          
          const latestPrice = sortedPrices[0]?.price;
          
          if (latestPrice && latestPrice >= MIN_VALID_PRICE) {
            console.log(`✅ Found market price: $${latestPrice} (${marketTire.brand} ${marketTire.diseno}) from ${sortedPrices[0]?.date || 'unknown date'}`);
            return latestPrice;
          }
        }
        
        // Fallback: use CPK-based estimation if available
        if (marketTire.cpk && marketTire.cpk > 0) {
          const estimatedPrice = Math.round(marketTire.cpk * STANDARD_TIRE_EXPECTED_KM);
          if (estimatedPrice >= MIN_VALID_PRICE) {
            console.log(`✅ Estimated price from CPK: $${estimatedPrice} (${marketTire.brand} ${marketTire.diseno})`);
            return estimatedPrice;
          }
        }
      }
      
      console.log(`⚠️ No valid market data found, using fallback price: $${FALLBACK_TIRE_PRICE}`);
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

  // Tracking variables for FORMAT B sparse data
  let lastSeenTipoVHC = '';
  let lastSeenPlaca = '';

  if (rows.length > 0) {
    console.log('📋 First row raw keys:', Object.keys(rows[0]));
  }

  // =========================
  // MAIN PROCESSING LOOP
  // =========================
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    
    // =========================
    // HANDLE SPARSE DATA (FORMAT B)
    // =========================
    if (isFormatB) {
      const currentTipoVHC = get(row, 'tipovhc')?.trim();
      const currentPlaca = get(row, 'placa_vehiculo')?.trim();
      
      if (currentTipoVHC) {
        lastSeenTipoVHC = currentTipoVHC;
      }
      
      if (currentPlaca) {
        lastSeenPlaca = currentPlaca;
      }
    }
    
    // =========================
    // TIRE ID HANDLING
    // =========================
    let tirePlacaRaw = get(row, 'llanta')?.trim();
    let tirePlaca = '';
    
    if (needsIdGeneration(tirePlacaRaw)) {
      tirePlaca = generateTireId().toLowerCase();
      console.log(`🔢 Generated ID for row ${rowIndex + 2}: ${tirePlaca} (original: "${tirePlacaRaw}")`);
    } else {
      tirePlaca = tirePlacaRaw.toLowerCase();
    }

    if (processedIds.has(tirePlaca)) {
      const errorMsg = `Error: Duplicate tire ID "${tirePlaca}" found in row ${rowIndex + 2}. Skipping this row.`;
      console.error(`❌ ${errorMsg}`);
      errors.push(errorMsg);
      continue;
    }

    processedIds.add(tirePlaca);

    // =========================
    // EXTRACT BASIC TIRE DATA
    // =========================
    const marca = get(row, 'marca').toLowerCase();
    let diseno = get(row, 'diseno_original').toLowerCase();
    const dimension = get(row, 'dimension').toLowerCase();
    const eje = get(row, 'eje').toLowerCase();
    const posicion = parseInt(get(row, 'posicion') || '0', 10);
    
    // Get tipovhc (from current row or carry forward in FORMAT B)
    let tipovhc = isFormatB 
      ? (get(row, 'tipovhc')?.trim() || lastSeenTipoVHC)
      : get(row, 'tipovhc')?.trim();
    
    tipovhc = normalizeTipoVHC(tipovhc);
    
    // =========================
    // PROFUNDIDAD INICIAL HANDLING
    // =========================

    // We need profundidades early to set profundidadInicial smartly
    const profIntEarly = parseFloat(get(row, 'profundidad_int') || '0');
    const profCenEarly = parseFloat(get(row, 'profundidad_cen') || '0');
    const profExtEarly = parseFloat(get(row, 'profundidad_ext') || '0');

    let profundidadInicial = parseFloat(get(row, 'profundidad_inicial') || '0');

    if (!profundidadInicial || profundidadInicial <= 0) {
      const maxObservedDepth = Math.max(profIntEarly, profCenEarly, profExtEarly);
      if (maxObservedDepth > 0) {
        // If any measured depth exceeds 22mm, use that as the baseline (+ 1mm)
        // Otherwise fall back to the default of 22mm
        profundidadInicial = maxObservedDepth > DEFAULT_PROFUNDIDAD_INICIAL
          ? maxObservedDepth + 1
          : DEFAULT_PROFUNDIDAD_INICIAL;
        warnings.push(`Row ${rowIndex + 2}: profundidad inicial inferred as ${profundidadInicial}mm from measured depths (max: ${maxObservedDepth}mm)`);
      } else {
        profundidadInicial = DEFAULT_PROFUNDIDAD_INICIAL;
        warnings.push(`Row ${rowIndex + 2}: Using default profundidad inicial: ${DEFAULT_PROFUNDIDAD_INICIAL}mm`);
      }
    }
    
    // =========================
    // VIDA DETECTION (FORMAT B)
    // =========================
    let vidaValor = '';
    let needsReencauche = false;
    let bandaName = '';
    
    if (isFormatB) {
      const marcaBanda = normalize(get(row, 'marca_banda'));
      bandaName = get(row, 'banda_name').toLowerCase();
      
      if (marcaBanda.includes('original')) {
        vidaValor = 'nueva';
        needsReencauche = false;
      } else if (marcaBanda.includes('reencauche') || marcaBanda.includes('rencauche')) {
        vidaValor = 'nueva'; // Start as nueva, will immediately reencauche
        needsReencauche = true;
        console.log(`🔄 Tire ${tirePlaca} will be created as nueva then reencauched with banda: ${bandaName}`);
      } else {
        vidaValor = 'nueva';
        needsReencauche = false;
      }
    } else {
      // FORMAT A - original logic
      vidaValor = get(row, 'vida').trim().toLowerCase();
      if (vidaValor === 'rencauche' || vidaValor === 'reencauche') {
        vidaValor = 'reencauche1';
        console.log(`🔄 Normalized vida from "${get(row, 'vida')}" to "reencauche1" for row ${rowIndex + 2}`);
      }
    }

    // =========================
    // VEHICLE HANDLING
    // =========================
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
        await this.vehicleService.updateKilometraje(
          vehicle.id,
          kilometrosVehiculo,
        );
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

    // =========================
    // TIRE DUPLICATE CHECK
    // =========================
    let tire = await this.prisma.tire.findFirst({
      where: { placa: tirePlaca },
    });

    if (tire) {
      const errorMsg = `Error: Tire ID "${tirePlaca}" already exists in database (row ${rowIndex + 2}). Skipping this row.`;
      console.error(`❌ ${errorMsg}`);
      errors.push(errorMsg);
      continue;
    }

    // =========================
// SYNC WITH MARKET DATA
// =========================
const {
  canonicalBrand,
  canonicalDiseno,
  canonicalDimension,
} = await this.marketDataService.syncTireWithMarketData(
  marca,
  diseno,
  dimension,
);

// Use canonical values going forward (corrects typos like "conttinental")
const finalMarca = canonicalBrand;
const finalDiseno = canonicalDiseno;
const finalDimension = canonicalDimension;
diseno = finalDiseno; 
    // =========================
    // FECHA INSTALACION
    // =========================
    const fechaInstalacionRaw = get(row, 'fecha_instalacion');
    const fechaInstalacion = fechaInstalacionRaw
      ? new Date(fechaInstalacionRaw)
      : new Date();

    // =========================
    // COST HANDLING WITH MARKET DATA FALLBACK
    // =========================
    const costoRaw = get(row, 'costo');
    let costoCell = parseCurrency(costoRaw);

    // If no valid cost provided, fetch from market data
    if (costoCell <= 0) {
      console.log(`💰 No cost provided for row ${rowIndex + 2}, fetching from market data...`);
      costoCell = await fetchTirePriceFromMarketData(finalMarca, finalDiseno, finalDimension);  // ✅ canonical
      warnings.push(`Row ${rowIndex + 2}: Cost fetched from market data: $${costoCell}`);
    } else {
      console.log(`💰 Row ${rowIndex + 2} - Using provided cost: $${costoCell}`);
    }

    // =========================
    // CREATE TIRE (ALWAYS START AS NUEVA FOR FORMAT B)
    // =========================
    tire = await this.prisma.tire.create({
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
        vida: vidaValor
          ? [{ fecha: new Date().toISOString(), valor: vidaValor }]
          : [],
        costo: costoCell > 0 
          ? [{ fecha: new Date().toISOString(), valor: costoCell }]
          : [],
        inspecciones: [],
        eventos: [],
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

    // =========================
    // TIME & KM CALCULATIONS
    // =========================
    const rec = await this.prisma.tire.findUnique({
      where: { id: tire.id },
    });
    if (!rec) continue;

    const now = new Date();
    const instalacionDate = rec.fechaInstalacion 
      ? new Date(rec.fechaInstalacion) 
      : now;

    let diasEnUso = Math.max(
      Math.floor((now.getTime() - instalacionDate.getTime()) / MS_POR_DIA),
      1,
    );

    // =========================
    // KILOMETROS ESTIMATION (with used tire detection)
    // =========================
    const kmLlantaExcel = parseFloat(get(row, 'kilometros_llanta') || '0');
    
    // Get profundidades for wear detection
    const profInt = profIntEarly;
    const profCen = profCenEarly;
    const profExt = profExtEarly;
    
    const minDepth = Math.min(profInt, profCen, profExt);
    const mmWorn = profundidadInicial - minDepth;
    
    const hasSignificantWear = mmWorn > SIGNIFICANT_WEAR_MM;
    const isRecentlyRegistered = diasEnUso < RECENT_REGISTRATION_DAYS;
    const isPremiumTire = costoCell >= PREMIUM_TIRE_THRESHOLD;
    const hasInspection = profInt > 0 || profCen > 0 || profExt > 0;
    
    let kilometrosEstimados = 0;
    let shouldEstimateTime = false; // Flag to know if we should recalculate time
    
    // Special case: Used tire being registered for the first time
    const LIMITE_LEGAL_MM = 2;
const usableDepth = profundidadInicial - LIMITE_LEGAL_MM;

if (kmLlantaExcel > 0) {
  // Always trust explicit KM from the file first
  kilometrosEstimados = kmLlantaExcel;

} else if (hasInspection && mmWorn > 0 && usableDepth > 0) {
  // We have depth readings — use wear-based estimation regardless of
  // how much wear has occurred. This is always more accurate than
  // time-based guessing, especially for recently registered tires.
  const expectedLifetimeKm = isPremiumTire
    ? PREMIUM_TIRE_EXPECTED_KM
    : STANDARD_TIRE_EXPECTED_KM;

  const kmPerMm = expectedLifetimeKm / usableDepth;
  kilometrosEstimados = Math.round(kmPerMm * mmWorn);
  shouldEstimateTime = true;

  console.log(
    `🔍 Wear-based KM estimation (row ${rowIndex + 2}): ` +
    `${mmWorn}mm worn × ${kmPerMm.toFixed(1)} km/mm = ${kilometrosEstimados} km ` +
    `(usableDepth: ${usableDepth}mm, lifetime: ${expectedLifetimeKm}km)`
  );
  warnings.push(
    `Row ${rowIndex + 2}: KM estimated from wear — ${kilometrosEstimados} km ` +
    `(${mmWorn}mm worn of ${usableDepth}mm usable)`
  );

} else {
  // No depth readings and no explicit KM — fall back to time-based
  kilometrosEstimados = Math.round((diasEnUso / 30) * KM_POR_MES);
}

    // =========================
    // TIME ESTIMATION (if recently registered but has significant KM)
    // =========================
    if (isRecentlyRegistered && kilometrosEstimados > 0 && shouldEstimateTime) {
      // Calculate estimated days based on KM traveled
      const kmPerDay = KM_POR_MES / 30; // 6000 km/month = 200 km/day
      const estimatedDays = Math.round(kilometrosEstimados / kmPerDay);
      
      diasEnUso = Math.max(estimatedDays, 1);
      
      console.log(`📅 Estimated time in use: ${diasEnUso} days (based on ${kilometrosEstimados} km at ${kmPerDay} km/day)`);
      warnings.push(`Row ${rowIndex + 2}: Time estimated from kilometers - ${diasEnUso} days from ${kilometrosEstimados} km`);
    }

    const mesesEnUso = diasEnUso / 30;

    // =========================
    // COST ARRAY
    // =========================
    const lastData = tireDataMap.get(tirePlaca) || { 
      lastVida: '', 
      lastCosto: -1 
    };

    const costosActuales: any[] = costoCell > 0 
      ? [{ fecha: now.toISOString(), valor: costoCell }]
      : [];

    const totalCost = costosActuales.reduce((sum, c) => {
      return sum + (typeof c?.valor === 'number' ? c.valor : 0);
    }, 0);

    let vidaArray = vidaValor
      ? [{ fecha: now.toISOString(), valor: vidaValor }]
      : [];

    lastData.lastVida = vidaValor;

    // =========================
    // INSPECTION CREATION (if applicable)
    // =========================
    if (hasInspection) {
      const cpk = kilometrosEstimados > 0 
        ? totalCost / kilometrosEstimados 
        : 0;

      const cpt = mesesEnUso > 0 
        ? totalCost / mesesEnUso 
        : 0;

      const desgaste = profundidadInicial - minDepth;

      let projectedKm = 0;
      if (desgaste > 0 && kilometrosEstimados > 0) {
        const kmPerMm = kilometrosEstimados / desgaste;
        const mmLeft = Math.max(minDepth - 2, 0); // 2mm legal limit
        const remainingKm = kmPerMm * mmLeft;
        projectedKm = kilometrosEstimados + remainingKm;
      }

      const projectedMonths = projectedKm / KM_POR_MES;

      const cpkProyectado = projectedKm > 0 
        ? totalCost / projectedKm 
        : 0;

      const cptProyectado = projectedMonths > 0 
        ? totalCost / projectedMonths 
        : 0;

      const inspecciones = [{
        fecha: now.toISOString(),
        profundidadInt: profInt,
        profundidadCen: profCen,
        profundidadExt: profExt,
        diasEnUso,
        mesesEnUso,
        kilometrosEstimados,
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

    // =========================
// UPDATE MARKET CPK (bulk upload, if inspection data present)
// =========================
if (hasInspection) {
  this.marketDataService.updateMarketCpkFromInspection(
    finalMarca,
    finalDiseno,
    finalDimension,
  ).catch((err) => {
    console.warn(`Market CPK update failed for row ${rowIndex + 2}: ${err.message}`);
  });
}

    // =========================
    // REENCAUCHE OPERATION (FORMAT B - if needed)
    // =========================
    if (needsReencauche) {
      try {
        console.log(`🔧 Performing reencauche operation for tire ${tire.id} (row ${rowIndex + 2})`);
        
        await this.updateVida(
          tire.id,
          'reencauche1',
          bandaName || finalDiseno,  // ✅ canonical
          REENCAUCHE_COST,
          profundidadInicial,
          undefined
        );
        
        console.log(`✅ Reencauche completed for tire ${tire.id}`);
      } catch (error) {
        const errorMsg = `Error performing reencauche for tire ${tirePlaca} (row ${rowIndex + 2}): ${error.message}`;
        console.error(`❌ ${errorMsg}`);
        errors.push(errorMsg);
      }
    }

    tireDataMap.set(tirePlaca, lastData);
  }

  // =========================
  // FINAL RESPONSE
  // =========================
  const successCount = processedIds.size;
  const errorCount = errors.length;
  const warningCount = warnings.length;

  let message = `Carga masiva completada. ${successCount} llantas procesadas exitosamente.`;
  
  if (warningCount > 0) {
    message += ` ${warningCount} advertencias encontradas.`;
  }
  
  if (errorCount > 0) {
    message += ` ${errorCount} errores encontrados.`;
  }

  return { 
    message,
    success: successCount,
    errors: errorCount,
    warnings: warningCount,
    details: {
      errors,
      warnings,
    }
  };
}

async findTiresByCompany(companyId: string) {
    return await this.prisma.tire.findMany({
      where: { companyId },
    });
}

async findTiresByVehicle(vehicleId: string) {
    if (!vehicleId) {
      throw new BadRequestException('vehicleId is required');
    }
    return await this.prisma.tire.findMany({
      where: { vehicleId },
    });
}

async updateInspection(tireId: string, updateDto: UpdateInspectionDto) {
  if (
    updateDto.profundidadInt === 0 &&
    updateDto.profundidadCen === 0 &&
    updateDto.profundidadExt === 0
  ) {
    return this.prisma.tire.findUnique({
      where: { id: tireId },
    });
  }
  const KM_POR_MES = 6000;
  const MS_POR_DIA = 1000 * 60 * 60 * 24;
  const PREMIUM_TIRE_THRESHOLD = 2000000;
  const PREMIUM_TIRE_EXPECTED_KM = 100000;
  const STANDARD_TIRE_EXPECTED_KM = 80000;
  const SIGNIFICANT_WEAR_MM = 5;
  const RECENT_REGISTRATION_DAYS = 30; // Adjust this threshold as needed

  // =========================
  // VALIDACIONES BÁSICAS
  // =========================
  const tire = await this.prisma.tire.findUnique({
    where: { id: tireId },
  });
  if (!tire) throw new BadRequestException('Tire not found');

  if (!tire.vehicleId) {
    throw new BadRequestException('Tire is not associated with a vehicle');
  }

  const vehicle = await this.prisma.vehicle.findUnique({
    where: { id: tire.vehicleId },
  });
  if (!vehicle) {
    throw new BadRequestException('Vehicle not found for tire');
  }

  // =========================
  // KILOMETRAJE VEHÍCULO
  // =========================
  const oldVehicleKm = vehicle.kilometrajeActual || 0;
  const newVehicleKm = updateDto.newKilometraje || 0;

  const odometerStuck =
    newVehicleKm === 0 || newVehicleKm === oldVehicleKm;

  let deltaKm = 0;

  if (!odometerStuck) {
    deltaKm = newVehicleKm - oldVehicleKm;
    if (deltaKm < 0) {
      throw new BadRequestException(
        'El nuevo kilometraje debe ser mayor o igual al actual',
      );
    }

    await this.prisma.tire.update({
      where: { id: tireId },
      data: { kilometrosRecorridos: { increment: deltaKm } },
    });
  }

  const updatedTire = await this.prisma.tire.findUnique({
    where: { id: tireId },
  });
  if (!updatedTire) {
    throw new BadRequestException('Tire not found after update');
  }

  // =========================
  // TIEMPO EN USO
  // =========================
  const now = new Date();
  const fechaInstalacion = updatedTire.fechaInstalacion ?? now;

  const diasEnUso = Math.max(
    Math.floor(
      (now.getTime() - new Date(fechaInstalacion).getTime()) /
        MS_POR_DIA,
    ),
    1,
  );

  const mesesEnUso = diasEnUso / 30;

  // =========================
  // DETECCIÓN DE LLANTA USADA RECIÉN REGISTRADA
  // =========================
  const minDepth = Math.min(
    updateDto.profundidadInt,
    updateDto.profundidadCen,
    updateDto.profundidadExt,
  );

  const profundidadInicial = updatedTire.profundidadInicial;
  const mmWorn = profundidadInicial - minDepth;

  const currentInspections = Array.isArray(updatedTire.inspecciones)
    ? updatedTire.inspecciones
    : [];
  
  const isFirstInspection = currentInspections.length === 0;
  const hasSignificantWear = mmWorn > SIGNIFICANT_WEAR_MM;

  // Calculate days since tire creation
  const tireCreatedAt = updatedTire.fechaInstalacion || now;
  const daysSinceCreation = Math.max(
    Math.floor(
      (now.getTime() - new Date(tireCreatedAt).getTime()) / MS_POR_DIA,
    ),
    0,
  );
  const isRecentlyRegistered = daysSinceCreation < RECENT_REGISTRATION_DAYS;

  // Get first cost to determine tire type
  const firstCostValue = Array.isArray(updatedTire.costo) && updatedTire.costo.length > 0
  ? ((updatedTire.costo[0] as any)?.valor || 0)
  : 0;
  
  const isPremiumTire = firstCostValue >= PREMIUM_TIRE_THRESHOLD;

  // =========================
  // KILOMETROS LLANTA (REAL O ESTIMADO)
  // =========================
  const realTireKm = updatedTire.kilometrosRecorridos || 0;
  let kilometrosEstimados = 0;

  // Special case: Used tire being registered for the first time
  if (
    odometerStuck &&
    realTireKm === 0 &&
    (isFirstInspection || hasSignificantWear) &&
    isRecentlyRegistered &&
    mmWorn > 0
  ) {
    // Use wear-based estimation for recently registered tires with significant wear
    const expectedLifetimeKm = isPremiumTire 
      ? PREMIUM_TIRE_EXPECTED_KM 
      : STANDARD_TIRE_EXPECTED_KM;
    
    const LIMITE_LEGAL_MM = 2;
    const usableDepth = profundidadInicial - LIMITE_LEGAL_MM;
    const kmPerMm = expectedLifetimeKm / usableDepth;
    const estimatedKmTraveled = Math.round(kmPerMm * mmWorn);
    
    kilometrosEstimados = estimatedKmTraveled;
    
  } else if (odometerStuck) {
    // Time-based estimation when odometer is unreliable
    kilometrosEstimados = Math.round(mesesEnUso * KM_POR_MES);
    
  } else {
    // Use actual tracked kilometers when odometer is working
    kilometrosEstimados = realTireKm;
  }

  // =========================
  // COSTO TOTAL
  // =========================
  const totalCost = Array.isArray(updatedTire.costo)
    ? updatedTire.costo.reduce(
        (sum, entry: any) => sum + (entry?.valor || 0),
        0,
      )
    : 0;

  // =========================
  // CPK / CPT
  // =========================
  const cpk =
    kilometrosEstimados > 0
      ? totalCost / kilometrosEstimados
      : 0;

  const cpt = mesesEnUso > 0 ? totalCost / mesesEnUso : 0;

  const LIMITE_LEGAL_MM = 2;

  // =========================
  // PROYECCIÓN DE VIDA ÚTIL
  // =========================
  let projectedKm = 0;

  if (mmWorn > 0 && kilometrosEstimados > 0) {
    const kmPerMm = kilometrosEstimados / mmWorn;

    const mmLeft = Math.max(
      minDepth - LIMITE_LEGAL_MM,
      0,
    );

    const remainingKm = kmPerMm * mmLeft;

    projectedKm = kilometrosEstimados + remainingKm;
  }

  const projectedMonths = projectedKm / KM_POR_MES;

  const cpkProyectado =
    projectedKm > 0 ? totalCost / projectedKm : 0;

  const cptProyectado =
    projectedMonths > 0 ? totalCost / projectedMonths : 0;

  // =========================
  // IMAGEN
  // =========================
  let finalImageUrl = updateDto.imageUrl;

  if (
    updateDto.imageUrl &&
    updateDto.imageUrl.startsWith('data:')
  ) {
    const base64Data = updateDto.imageUrl.split(',')[1];
    const fileBuffer = Buffer.from(base64Data, 'base64');
    const fileName = `tire-inspections/${tireId}-${Date.now()}.jpg`;

    finalImageUrl = await uploadFileToS3(
      fileBuffer,
      fileName,
      'image/jpeg',
    );
  }

  // =========================
  // NUEVA INSPECCIÓN
  // =========================
  const newInspection = {
    profundidadInt: updateDto.profundidadInt,
    profundidadCen: updateDto.profundidadCen,
    profundidadExt: updateDto.profundidadExt,
    imageUrl: finalImageUrl,
    fecha: now.toISOString(),

    diasEnUso,
    mesesEnUso,
    kilometrosEstimados,

    cpk,
    cpkProyectado,
    cpt,
    cptProyectado,
  };

  const updatedInspecciones = [
    ...currentInspections,
    newInspection,
  ];

  // =========================
  // GUARDAR LLANTA
  // =========================
  const finalTire = await this.prisma.tire.update({
    where: { id: tireId },
    data: {
      inspecciones: updatedInspecciones,
      kilometrosRecorridos: kilometrosEstimados,
      diasAcumulados: diasEnUso,
    },
  });

  // =========================
  // ACTUALIZAR VEHÍCULO (SI APLICA)
  // =========================
  if (!odometerStuck) {
    await this.prisma.vehicle.update({
      where: { id: vehicle.id },
      data: { kilometrajeActual: newVehicleKm },
    });
  }

  // =========================
  // NOTIFICACIONES
  // =========================
  await this.notificationsService.deleteByTire(finalTire.id);

  const analysis = this.analyzeTire(finalTire);
  const recommendation =
    analysis?.recomendaciones?.[0] ?? '';

  if (
    recommendation.startsWith('🔴') ||
    recommendation.startsWith('🟡')
  ) {
    await this.notificationsService.createNotification({
      title: `Llantas - ${
        recommendation.includes('🔴')
          ? 'Crítico'
          : 'Precaución'
      }`,
      message: recommendation,
      type: recommendation.includes('🔴')
        ? 'critical'
        : 'warning',
      tireId: finalTire.id,
      vehicleId: finalTire.vehicleId ?? undefined,
      companyId: finalTire.companyId ?? undefined,
    });
  }

  // =========================
// UPDATE MARKET DATA CPK
// =========================
// Fire-and-forget — never block the inspection response
this.marketDataService.updateMarketCpkFromInspection(
  finalTire.marca,
  finalTire.diseno,
  finalTire.dimension,
).catch((err) => {
  console.warn(`Market CPK update failed silently: ${err.message}`);  // ✅ safe fallback
});

  return finalTire;
}
  
async updateVida(
  tireId: string,
  newValor: string | undefined,
  banda?: string,
  costo?: number,
  profundidadInicial?: number | string, // Accept both types safely
  desechoData?: {
    causales: string;
    milimetrosDesechados: number;
  }
) {
  console.log('Backend Debug - Received parameters:', {
    tireId,
    newValor,
    banda,
    costo,
    profundidadInicial,
    profundidadInicialType: typeof profundidadInicial,
    desechoData
  });

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
  if (!tire) {
    throw new BadRequestException('Tire not found');
  }

  const vidaArray = (Array.isArray(tire.vida) ? tire.vida : []) as Array<{
    fecha: string;
    valor: string;
  }>;

  const lastEntry = vidaArray.length ? vidaArray[vidaArray.length - 1] : null;
  if (lastEntry) {
    const lastIndex = allowed.indexOf(lastEntry.valor.toLowerCase());
    if (lastIndex < 0) {
      throw new BadRequestException('Último valor de vida inválido');
    }
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
    } else if (
      normalizedValor === 'reencauche1' &&
      existingCosto.length
    ) {
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
      const insps = [...tire.inspecciones] as Array<{
        fecha: string;
        cpk?: number;
      }>;
      insps.sort(
        (a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime()
      );
      cpk = insps[0]?.cpk ?? 0;
    }

    const designValue = banda?.trim() || tire.diseno;
    const costoForPrimera =
      typeof costo === 'number' && costo > 0
        ? costo
        : Array.isArray(tire.costo) && tire.costo.length
        ? ((tire.costo[tire.costo.length - 1] as any).valor as number) || 0
        : 0;
    const kms = tire.kilometrosRecorridos || 0;

    updateData.primeraVida = [
      {
        diseno: designValue,
        cpk,
        costo: costoForPrimera,
        kilometros: kms,
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
      fecha: new Date().toISOString(), // ✅ Added timestamp
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
  // Fetch the tire.
  const tire = await this.prisma.tire.findUnique({ where: { id: tireId } });
  if (!tire) {
    throw new BadRequestException('Tire not found');
  }
  
  // Parse the existing eventos array (if any).
  const eventosArray: { valor: string; fecha: string }[] = Array.isArray(tire.eventos)
    ? tire.eventos as any
    : [];
  
  // Create a new event entry.
  const newEvent = {
    valor: newValor,
    fecha: new Date().toISOString(),
  };
  
  // Append the new event.
  const updatedEventos = [...eventosArray, newEvent];
  
  // Update the tire record with the new eventos array.
  const updatedTire = await this.prisma.tire.update({
    where: { id: tireId },
    data: { eventos: updatedEventos },
  });
  
  return updatedTire;
}

async updatePositions(placa: string, updates: { [position: string]: string | string[] }) {
  // Find the vehicle by placa
  const vehicle = await this.prisma.vehicle.findFirst({
    where: { placa }
  });
  if (!vehicle) {
    throw new BadRequestException('Vehicle not found for the given placa');
  }

  // First, reset all tires for this vehicle to unassigned (posicion = null)
  // This ensures we have a clean slate before applying new positions
  await this.prisma.tire.updateMany({
    where: { 
      vehicleId: vehicle.id,
      placa: placa 
    },
data: { posicion: 0 }
  });

  // Process all updates
  for (const pos in updates) {
    const tireIds = Array.isArray(updates[pos]) ? updates[pos] : [updates[pos]];
    
    for (const tireId of tireIds) {
      const tire = await this.prisma.tire.findUnique({ where: { id: tireId } });
      
      if (!tire) {
        throw new BadRequestException(`Tire with id ${tireId} not found`);
      }
      if (tire.vehicleId !== vehicle.id) {
        throw new BadRequestException(`Tire with id ${tireId} does not belong to vehicle with plate ${placa}`);
      }
      
      // Set the tire position
      const posicion = pos === '0' ? 0 : parseInt(pos, 10);
      await this.prisma.tire.update({
        where: { id: tireId },
        data: { posicion }
      });
    }
  }

  return { message: 'Positions updated successfully' };
}

async analyzeTires(vehiclePlaca: string) {
  const vehicle = await this.prisma.vehicle.findFirst({
    where: { placa: vehiclePlaca }
  });

  if (!vehicle) throw new BadRequestException(`Vehicle with placa ${vehiclePlaca} not found`);

  const tires = await this.prisma.tire.findMany({
    where: { vehicleId: vehicle.id }
  });

  if (!tires || tires.length === 0)
    throw new BadRequestException(`No tires found for vehicle with placa ${vehiclePlaca}`);

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
      ]
    };
  }

  const lastInspections = [...tire.inspecciones]
    .sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime())
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

  // Priority 1: Critical depth
  if (profundidadActual <= 2) {
    recomendacion = "🔴 Cambio inmediato: Desgaste crítico. Reemplazo urgente.";
  }
  // Priority 2: No depth issue, but uneven wear
  else if (delta1 > 3 || delta2 > 3 || delta3 > 3) {
    recomendacion = "🟡 Desgaste irregular: Diferencias notables entre zonas. Revisar alineación o presión.";
  }
  // Priority 3: Poor CPK
  else if (cpk && cpk < 5) {
    recomendacion = "🔴 CPK muy bajo: Alto costo por kilómetro. Evaluar desempeño de la llanta.";
  }
  // Priority 4: Under/Over inflation
  else if (presion != null && (presion < 100 || presion > 130)) {
    recomendacion = `🟡 Presión fuera de rango: Actual: ${presion} PSI. Ajustar conforme a especificación.`;
  }
  // Priority 5: Low but not critical depth
  else if (profundidadActual <= 4) {
    recomendacion = "🟡 Revisión frecuente: La profundidad está bajando. Monitorear en próximas inspecciones.";
  }
  // Priority 7: Everything fine
  else {
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

  // 1️⃣ Narrow the JSON field into an array
  const inspeccionesArray = Array.isArray(tire.inspecciones)
    ? tire.inspecciones as Array<{ fecha: string }>
    : [];

  // 2️⃣ Filter out the one with the matching fecha
  const updated = inspeccionesArray.filter(i => i.fecha !== fecha);

  // 3️⃣ Persist back as JSON
  await this.prisma.tire.update({
    where: { id: tireId },
    data: { inspecciones: updated },
  });

  return { message: 'Inspección eliminada' };
}

async findAllTires() {
    // Admin-only access, return all tires without filtering by company
    return await this.prisma.tire.findMany();
  }
  
async assignTiresToVehicle(vehiclePlaca: string, tireIds: string[]) {
  const vehicle = await this.prisma.vehicle.findFirst({
    where: { placa: vehiclePlaca }
  });
  if (!vehicle) {
    throw new BadRequestException('Vehicle not found');
  }

  // Update each tire to belong to this vehicle
  await this.prisma.tire.updateMany({
    where: { id: { in: tireIds } },
    data: {
      vehicleId: vehicle.id,
    }
  });

  // Fix vehicle tireCount
  await this.prisma.vehicle.update({
    where: { id: vehicle.id },
    data: { tireCount: { increment: tireIds.length } }
  });

  return { message: 'Tires assigned successfully', count: tireIds.length };
}

async unassignTiresFromVehicle(tireIds: string[]) {
  const tires = await this.prisma.tire.findMany({ where: { id: { in: tireIds } } });
  
  // Decrement tireCount for each affected vehicle
  const vehicleIds = [...new Set(tires.map(t => t.vehicleId).filter((id): id is string => id !== null))];
  for (const vid of vehicleIds) {
    const count = tires.filter(t => t.vehicleId === vid).length;
    await this.prisma.vehicle.update({
      where: { id: vid },
      data: { tireCount: { decrement: count } }
    });
  }

  await this.prisma.tire.updateMany({
    where: { id: { in: tireIds } },
    data: { vehicleId: null, posicion: 0 }
  });

  return { message: 'Tires unassigned successfully', count: tireIds.length };
}
}