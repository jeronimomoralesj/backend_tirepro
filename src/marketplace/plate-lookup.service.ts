import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MarketplaceCache } from './marketplace-cache.service';
import { PlateScraperService } from './plate-scraper.service';

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
  // Empty fallback — anything we couldn't classify falls through to
  // the marketplace hero's vehicle-name autocomplete, which gives the
  // buyer a precise per-model resolution. The previous default of
  // tractomula sizes (295/80R22.5) was actively misleading for cars.
  return [];
}

// Regional datasets on datos.gov.co with real vehicle plate data.
// Only free / EC2-friendly path that actually works in 2026 — every
// other free option (Sura, Falabella, ComparaOnline, RUNT, SIMIT)
// either WAF-blocks AWS IPs, requires a paid key, or sits behind
// captcha. The list below is verified against the live Socrata API
// (May 2026); each dataset has been tested with `$where=<field>='ABC123'`
// and confirmed to return at least clase + marca + modelo data.
const DATOS_GOV_DATASETS = [
  { id: 'x9pp-pcn5', plateField: 'placa',     region: 'Risaralda' },
  { id: 'g7i9-xkxz', plateField: 'placa',     region: 'Floridablanca' },
  { id: 'dkxf-ikd7', plateField: 'placa',     region: 'Caldas' },
  { id: 'syiu-8mvf', plateField: 'placa',     region: 'Barbosa' },
  { id: 'fvnt-frpb', plateField: 'placa',     region: 'Transporte publico' },
  { id: '5in3-nedb', plateField: 'nro_placa', region: 'Barbosa (actualizado)' },
  { id: '2vr3-dink', plateField: 'placa',     region: 'Malambo' },
  // Added May 2026 after auditing the Socrata catalog for additional
  // searchable plate datasets. Coverage is still narrow per dataset
  // (each is one municipality / one vehicle category), but in
  // aggregate the parallel fan-out hits roughly twice as many
  // plates as the previous list.
  { id: '5ue6-jtmx', plateField: 'placa',     region: 'Vehiculos GNV (nacional)' },
  { id: 'a6et-uhjn', plateField: 'placa',     region: 'Carros GLP distribuidor' },
  { id: 'kvf9-pwe6', plateField: 'placas',    region: 'Copacabana pico y placa' },
  // Second-pass verification (May 2026) — these IDs returned a row
  // when probed with `$limit=1` and contain a `placa` field. Marca
  // / modelo coverage varies per dataset; the parallel fan-out in
  // queryDatosGov picks the first hit anywhere.
  { id: '72nf-y4v3', plateField: 'placa',     region: 'Multas Bucaramanga' },
  { id: 'tfrd-amb4', plateField: 'placa',     region: 'Registro vehicular regional' },
  { id: 'isnx-a8fc', plateField: 'placa',     region: 'Vehículos servicio público' },
  { id: 'wmr7-xdpj', plateField: 'placa',     region: 'Vehículos institucionales' },
  { id: 'ghej-cwz5', plateField: 'placa',     region: 'Multas regional A' },
  { id: 'atkg-vhpp', plateField: 'placa',     region: 'Multas regional B' },
  { id: 'bptt-m74m', plateField: 'placa',     region: 'Registro automotor' },
  // p29a-y4rc dropped — Socrata returns 404 ("Not found") for this
  // dataset id since early 2026. Re-add if it comes back online.
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
  private readonly CACHE_TTL = 24 * 60 * 60 * 1000; // 24h
  private readonly CACHE_PREFIX = 'plate:';

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: MarketplaceCache,
    private readonly scraper: PlateScraperService,
  ) {}

  async lookupPlate(placa: string): Promise<LookupResult> {
    const normalized = placa.toUpperCase().replace(/[^A-Z0-9]/g, '');

    // 1. Redis cache (cross-instance — every Node behind the LB shares
    //    the same cached plate result for 24h). Beats hitting Postgres
    //    or the scrapers on every page reload.
    const cached = await this.cache.get<LookupResult>(`${this.CACHE_PREFIX}${normalized}`);
    if (cached) return cached;

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

    // 4. Query datos.gov.co regional datasets in parallel.
    //    Several of the catalog's plate-bearing datasets are FINES /
    //    multas registries — they contain a `placa` column but no
    //    marca / modelo / clase. A plate-only "hit" tells us nothing
    //    useful and previously fell through to a hardcoded
    //    tractomula-default in matchVehicleType(''), which surfaced
    //    295/80R22.5 dimensions for cars. Treat any hit without
    //    actual vehicle metadata as a miss so the upstream caller
    //    routes the user to the community autocomplete instead.
    try {
      const govResult = await this.queryDatosGov(normalized);
      const hasUsefulData = govResult && (
        govResult.marca || govResult.linea || govResult.modelo || govResult.clase
      );
      if (hasUsefulData) {
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
      if (govResult) {
        this.logger.log(`datos.gov.co matched ${normalized} but only on the plate column — skipping useless hit`);
      }
    } catch (err) {
      this.logger.warn(`datos.gov.co failed for ${normalized}: ${err}`);
    }

    // 5. Headless scrape — last-resort tier for plates the gov sources
    //    don't have (commercial, recently registered, etc.). Wrapped in
    //    try/catch so a scraper outage never bubbles up as a 500.
    try {
      const scraped = await this.scraper.scrapePlate(normalized);
      if (scraped && (scraped.marca || scraped.linea || scraped.modelo || scraped.clase)) {
        this.savePlateCache(normalized, scraped, 'scraper');
        return this.cacheAndReturn({
          found: true, source: 'scraper', placa: normalized,
          marca: scraped.marca, linea: scraped.linea,
          modelo: scraped.modelo, clase: scraped.clase,
          servicio: scraped.servicio,
          dimensions: matchVehicleType(scraped.clase ?? ''),
        });
      }
    } catch (err) {
      this.logger.warn(`Scraper failed for ${normalized}: ${err}`);
    }

    // 6. Motorcycle plate format detection (cheaper than tier 5, but
    //    only fires on format match — kept here as a final-final
    //    fallback for bikes the scraper also missed).
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
   * Called by the frontend when a user manually identifies their
   * vehicle. Two callers today:
   *
   * 1. Community vehicle-class fallback (legacy) — caller sends just
   *    `clase` (AUTOMOVIL / CAMIONETA / TRACTOMULA / …) and the
   *    backend infers generic dimensions from TIRE_MAP.
   * 2. Vehicle-name autocomplete (the marketplace hero plate-fallback
   *    flow) — caller resolves the vehicle against the client-side
   *    VEHICLE_DB and sends marca + linea + dimensions[] alongside
   *    clase. We persist all of it so the next buyer with the same
   *    plate gets the full vehicle resolution back, not just a
   *    generic class.
   *
   * Either path lands the row in plate_cache so future cache hits
   * skip the gov-source fan-out entirely.
   */
  async saveCommunityLookup(
    placa: string,
    clase: string,
    extras?: { marca?: string; linea?: string; modelo?: string; dimensions?: string[] },
  ): Promise<LookupResult> {
    const normalized = placa.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const upperClase = clase.toUpperCase().trim();
    const marca = extras?.marca?.toUpperCase().trim() || null;
    const linea = extras?.linea?.toUpperCase().trim() || null;
    const modelo = extras?.modelo?.toString().trim() || null;
    // Trust the client-supplied dimensions when present (more precise
    // — keyed off the actual model). Fall back to the class-level
    // TIRE_MAP when the caller only sent `clase`.
    const dimensions = extras?.dimensions && extras.dimensions.length > 0
      ? extras.dimensions
      : matchVehicleType(upperClase);

    await this.prisma.plateCache.upsert({
      where:  { placa: normalized },
      create: {
        placa:    normalized,
        clase:    upperClase,
        marca,
        linea,
        modelo,
        source:   'community',
      },
      update: {
        clase:    upperClase,
        // Only overwrite marca/linea/modelo when the new payload has
        // them — so a user-class-only follow-up doesn't blow away
        // richer data we already had.
        ...(marca  ? { marca }  : {}),
        ...(linea  ? { linea }  : {}),
        ...(modelo ? { modelo } : {}),
        lookups:  { increment: 1 },
      },
    });

    const result: LookupResult = {
      found:      true,
      source:     'community',
      placa:      normalized,
      clase:      upperClase,
      marca:      marca ?? undefined,
      linea:      linea ?? undefined,
      modelo:     modelo ?? undefined,
      dimensions,
    };

    void this.cache.set(`${this.CACHE_PREFIX}${normalized}`, result, this.CACHE_TTL);
    return result;
  }

  private cacheAndReturn(result: LookupResult): LookupResult {
    // Fire-and-forget Redis write — the call site doesn't need to
    // await persistence to return the lookup synchronously to the
    // user. MarketplaceCache.set is already exception-swallowing so a
    // Redis blip never bubbles up as a 500 here.
    void this.cache.set(`${this.CACHE_PREFIX}${result.placa}`, result, this.CACHE_TTL);
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

}
