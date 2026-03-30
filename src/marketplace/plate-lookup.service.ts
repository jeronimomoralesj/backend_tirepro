import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Colombian vehicle type → common tire dimensions
const TIRE_MAP: Record<string, string[]> = {
  // Heavy
  'TRACTOCAMION':    ['295/80R22.5', '11R22.5', '315/80R22.5', '12R22.5'],
  'TRACTOMULA':      ['295/80R22.5', '11R22.5', '315/80R22.5', '12R22.5'],
  'CAMION':          ['295/80R22.5', '11R22.5', '12R22.5'],
  'VOLQUETA':        ['12R24.5', '11R24.5', '315/80R22.5', '12R22.5'],
  // Medium
  'CAMIONETA':       ['235/75R15', '265/70R16', '245/70R16'],
  'FURGON':          ['215/75R17.5', '235/75R17.5', '7.50R16'],
  'MICROBUS':        ['215/75R17.5', '7.50R16', '225/70R19.5'],
  // Bus
  'BUS':             ['295/80R22.5', '275/80R22.5', '11R22.5'],
  'BUSETA':          ['215/75R17.5', '235/75R17.5', '7.50R16'],
  // Light
  'AUTOMOVIL':       ['195/65R15', '205/55R16', '215/60R16'],
  'CAMPERO':         ['265/70R16', '245/70R16', '235/75R15'],
  'PICKUP':          ['265/70R16', '245/70R16', '255/70R16'],
  // Motorcycles
  'MOTOCICLETA':     ['120/80-17', '90/90-18', '110/80-17'],
  'MOTOCARRO':       ['4.00-8', '4.50-12'],
};

function matchVehicleType(clase: string): string[] {
  const upper = (clase ?? '').toUpperCase().trim();
  if (TIRE_MAP[upper]) return TIRE_MAP[upper];
  for (const [key, dims] of Object.entries(TIRE_MAP)) {
    if (upper.includes(key) || key.includes(upper)) return dims;
  }
  if (upper.includes('TRACT') || upper.includes('CABEZOT')) return TIRE_MAP['TRACTOCAMION'];
  if (upper.includes('VOLQU')) return TIRE_MAP['VOLQUETA'];
  if (upper.includes('BUS') && !upper.includes('MICRO')) return TIRE_MAP['BUS'];
  if (upper.includes('MICRO') || upper.includes('BUSET')) return TIRE_MAP['BUSETA'];
  if (upper.includes('CAMION') && !upper.includes('ETA')) return TIRE_MAP['CAMION'];
  if (upper.includes('CAMIONETA') || upper.includes('PICKUP') || upper.includes('PICK')) return TIRE_MAP['PICKUP'];
  if (upper.includes('FURG')) return TIRE_MAP['FURGON'];
  if (upper.includes('CAMP') || upper.includes('SUV') || upper.includes('4X4')) return TIRE_MAP['CAMPERO'];
  if (upper.includes('AUTO') || upper.includes('SEDAN') || upper.includes('HATCH')) return TIRE_MAP['AUTOMOVIL'];
  if (upper.includes('MOTO') && upper.includes('CARRO')) return TIRE_MAP['MOTOCARRO'];
  if (upper.includes('MOTO')) return TIRE_MAP['MOTOCICLETA'];
  return ['295/80R22.5', '11R22.5'];
}

// Regional datasets on datos.gov.co with real vehicle plate data
const DATOS_GOV_DATASETS = [
  { id: 'x9pp-pcn5', plateField: 'placa', region: 'Risaralda' },
  { id: 'g7i9-xkxz', plateField: 'placa', region: 'Floridablanca' },
  { id: 'p29a-y4rc', plateField: 'placa', region: 'Cucuta' },
  { id: 'dkxf-ikd7', plateField: 'placa', region: 'Caldas' },
  { id: 'syiu-8mvf', plateField: 'placa', region: 'Barbosa' },
  { id: 'fvnt-frpb', plateField: 'placa', region: 'Transporte publico' },
  { id: '5in3-nedb', plateField: 'nro_placa', region: 'Barbosa (actualizado)' },
  { id: '2vr3-dink', plateField: 'placa', region: 'Malambo' },
];

interface LookupResult {
  found: boolean;
  source: string;
  placa: string;
  marca?: string;
  linea?: string;
  modelo?: string;
  clase?: string;
  servicio?: string;
  dimensions: string[];
}

@Injectable()
export class PlateLookupService {
  private readonly logger = new Logger(PlateLookupService.name);
  private memCache = new Map<string, { data: LookupResult; ts: number }>();
  private readonly CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

  constructor(private readonly prisma: PrismaService) {}

  async lookupPlate(placa: string): Promise<LookupResult> {
    const normalized = placa.toUpperCase().replace(/[^A-Z0-9]/g, '');

    // 1. Memory cache
    const memCached = this.memCache.get(normalized);
    if (memCached && Date.now() - memCached.ts < this.CACHE_TTL) {
      return memCached.data;
    }

    // 2. Check our vehicles DB
    try {
      const vehicle = await this.prisma.vehicle.findFirst({
        where: { placa: { equals: normalized, mode: 'insensitive' } },
        include: { tires: { select: { dimension: true }, where: { vidaActual: { not: 'fin' } } } },
      });
      if (vehicle) {
        const dims = [...new Set(vehicle.tires.map(t => t.dimension).filter(Boolean))];
        return this.cacheAndReturn({
          found: true, source: 'tirepro', placa: normalized,
          clase: vehicle.tipovhc ?? undefined,
          dimensions: dims.length > 0 ? dims : matchVehicleType(vehicle.tipovhc ?? ''),
        });
      }
    } catch { /* */ }

    // 3. Check persistent plate_cache (crowdsourced DB)
    try {
      const cached = await this.prisma.plateCache.findUnique({ where: { placa: normalized } });
      if (cached) {
        // Bump lookup count (fire and forget)
        this.prisma.plateCache.update({
          where: { placa: normalized },
          data: { lookups: { increment: 1 } },
        }).catch(() => {});

        return this.cacheAndReturn({
          found: true, source: cached.source, placa: normalized,
          marca: cached.marca ?? undefined,
          linea: cached.linea ?? undefined,
          modelo: cached.modelo ?? undefined,
          clase: cached.clase ?? undefined,
          servicio: cached.servicio ?? undefined,
          dimensions: matchVehicleType(cached.clase ?? ''),
        });
      }
    } catch { /* */ }

    // 4. Query datos.gov.co regional datasets in parallel
    try {
      const govResult = await this.queryDatosGov(normalized);
      if (govResult) {
        // Save to plate_cache for future lookups
        this.savePlateCache(normalized, govResult, 'runt');
        return this.cacheAndReturn({
          found: true, source: 'runt', placa: normalized,
          marca: govResult.marca, linea: govResult.linea,
          modelo: govResult.modelo, clase: govResult.clase,
          servicio: govResult.servicio,
          dimensions: matchVehicleType(govResult.clase ?? ''),
        });
      }
    } catch (err) {
      this.logger.warn(`datos.gov.co failed for ${normalized}: ${err}`);
    }

    // 5. Free web scraper fallback
    try {
      const scraped = await this.scrapePublicSources(normalized);
      if (scraped) {
        this.savePlateCache(normalized, scraped, 'web');
        return this.cacheAndReturn({
          found: true, source: 'runt', placa: normalized,
          marca: scraped.marca, linea: scraped.linea,
          modelo: scraped.modelo, clase: scraped.clase,
          dimensions: matchVehicleType(scraped.clase ?? ''),
        });
      }
    } catch (err) {
      this.logger.warn(`Web scraper failed for ${normalized}: ${err}`);
    }

    // 6. Motorcycle plate format detection
    if (/^[A-Z]{3}\d{2}[A-Z]$/.test(normalized)) {
      return this.cacheAndReturn({
        found: true, source: 'formato', placa: normalized,
        clase: 'MOTOCICLETA',
        dimensions: TIRE_MAP['MOTOCICLETA'],
      });
    }

    // 7. Not found
    return { found: false, source: 'none', placa: normalized, dimensions: [] };
  }

  /**
   * Called by the frontend when a user manually selects their vehicle type.
   * This builds the crowdsourced DB so the next person gets instant results.
   */
  async saveCommunityLookup(placa: string, clase: string): Promise<LookupResult> {
    const normalized = placa.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const upperClase = clase.toUpperCase().trim();

    await this.prisma.plateCache.upsert({
      where: { placa: normalized },
      create: { placa: normalized, clase: upperClase, source: 'community' },
      update: { clase: upperClase, lookups: { increment: 1 } },
    });

    const result: LookupResult = {
      found: true,
      source: 'community',
      placa: normalized,
      clase: upperClase,
      dimensions: matchVehicleType(upperClase),
    };

    this.memCache.set(normalized, { data: result, ts: Date.now() });
    return result;
  }

  private cacheAndReturn(result: LookupResult): LookupResult {
    this.memCache.set(result.placa, { data: result, ts: Date.now() });
    return result;
  }

  private savePlateCache(placa: string, data: { marca?: string; linea?: string; modelo?: string; clase?: string; servicio?: string }, source: string) {
    this.prisma.plateCache.upsert({
      where: { placa },
      create: { placa, marca: data.marca, linea: data.linea, modelo: data.modelo, clase: data.clase, servicio: data.servicio, source },
      update: { marca: data.marca, linea: data.linea, modelo: data.modelo, clase: data.clase, servicio: data.servicio, source },
    }).catch((err) => this.logger.warn(`Failed to cache plate ${placa}: ${err}`));
  }

  private async queryDatosGov(placa: string): Promise<{
    marca?: string; linea?: string; modelo?: string; clase?: string; servicio?: string;
  } | null> {
    const queries = DATOS_GOV_DATASETS.map(async (ds) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);
        const url = `https://www.datos.gov.co/resource/${ds.id}.json?$where=${ds.plateField}='${placa}'&$limit=1`;
        const res = await fetch(url, {
          headers: { 'Accept': 'application/json', 'User-Agent': 'TirePro/1.0' },
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (res.ok) {
          const data = await res.json();
          if (data?.length > 0) {
            const v = data[0];
            return {
              marca: v.marca ?? undefined,
              linea: v.linea ?? undefined,
              modelo: v.modelo ?? v.a_o_modelo ?? undefined,
              clase: v.clase_vehiculo ?? v.clase ?? v.tipo_de_vehiculo ?? undefined,
              servicio: v.tipo_servicio ?? v.servicio ?? undefined,
              _region: ds.region,
            };
          }
        }
      } catch { /* */ }
      return null;
    });
    const results = await Promise.all(queries);
    const found = results.find(r => r !== null);
    if (found) {
      this.logger.log(`Plate ${placa} found in ${found._region}`);
      return found;
    }
    return null;
  }

  /**
   * Free web scraper: tries multiple public Colombian vehicle lookup sources.
   * No API keys required. Falls through gracefully if sites are down.
   */
  private async scrapePublicSources(placa: string): Promise<{
    marca?: string; linea?: string; modelo?: string; clase?: string;
  } | null> {
    // Try sources in sequence — return first hit
    const scrapers = [
      () => this.scrapeSIMIT(placa),
      () => this.scrapeRUNTPublic(placa),
    ];
    for (const scraper of scrapers) {
      try {
        const result = await scraper();
        if (result && (result.marca || result.clase)) return result;
      } catch { /* try next */ }
    }
    return null;
  }

  /**
   * SIMIT (Sistema Integrado de Información sobre Multas y Sanciones por
   * Infracciones de Tránsito) — public consultation returns vehicle info.
   */
  private async scrapeSIMIT(placa: string): Promise<{
    marca?: string; linea?: string; modelo?: string; clase?: string;
  } | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(
        `https://consulta.simit.org.co/api/v1/vehicles/${encodeURIComponent(placa)}`,
        {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
          signal: controller.signal,
        },
      );
      clearTimeout(timeout);
      if (!res.ok) return null;
      const data = await res.json();
      const v = data?.vehicle ?? data?.vehiculo ?? data;
      if (!v) return null;
      return {
        marca: v.marca ?? v.brand ?? undefined,
        linea: v.linea ?? v.line ?? v.modelo_vehiculo ?? undefined,
        modelo: v.modelo ?? v.year ?? v.anio ?? undefined,
        clase: v.clase ?? v.clase_vehiculo ?? v.type ?? v.vehicleType ?? undefined,
      };
    } catch {
      clearTimeout(timeout);
      return null;
    }
  }

  /**
   * Public RUNT-adjacent lookup — tries the RUNT public consultation page
   * and parses vehicle data from the HTML response.
   */
  private async scrapeRUNTPublic(placa: string): Promise<{
    marca?: string; linea?: string; modelo?: string; clase?: string;
  } | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      // Try the public RUNT consultation endpoint
      const res = await fetch(
        `https://www.rfrunt.co/api/consultar/${encodeURIComponent(placa)}`,
        {
          headers: {
            'Accept': 'application/json, text/html',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
          signal: controller.signal,
        },
      );
      clearTimeout(timeout);
      if (!res.ok) return null;

      const contentType = res.headers.get('content-type') ?? '';

      if (contentType.includes('json')) {
        const data = await res.json();
        const v = data?.vehiculo ?? data?.vehicle ?? data;
        if (!v) return null;
        return {
          marca: v.marca ?? v.brand ?? undefined,
          linea: v.linea ?? v.line ?? undefined,
          modelo: v.modelo ?? v.year ?? undefined,
          clase: v.clase ?? v.clase_vehiculo ?? v.tipo ?? undefined,
        };
      }

      // HTML response — try to extract vehicle info via regex
      const html = await res.text();
      const extract = (label: string): string | undefined => {
        const patterns = [
          new RegExp(`${label}[:\\s]*<[^>]*>\\s*([^<]+)`, 'i'),
          new RegExp(`<td[^>]*>${label}</td>\\s*<td[^>]*>\\s*([^<]+)`, 'i'),
          new RegExp(`"${label}"\\s*:\\s*"([^"]+)"`, 'i'),
        ];
        for (const p of patterns) {
          const m = html.match(p);
          if (m?.[1]?.trim()) return m[1].trim();
        }
        return undefined;
      };

      const marca = extract('marca') ?? extract('Marca');
      const linea = extract('linea') ?? extract('Línea') ?? extract('Linea');
      const modelo = extract('modelo') ?? extract('Modelo') ?? extract('Año');
      const clase = extract('clase') ?? extract('Clase') ?? extract('tipo_vehiculo') ?? extract('Tipo');

      if (marca || clase) return { marca, linea, modelo, clase };
    } catch {
      clearTimeout(timeout);
    }
    return null;
  }
}
