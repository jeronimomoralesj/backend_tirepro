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

// Fuzzy match vehicle class to our map
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

// Infer vehicle type from Colombian plate format
function inferFromPlateFormat(placa: string): {
  found: boolean; clase?: string; dimensions: string[];
} {
  // Colombian plate formats:
  // Motorcycles: 3 letters + 2 digits + 1 letter (e.g., ABC12D) — since 2008
  // Cars/trucks old: 3 letters + 3 digits (e.g., ABC123)
  // Diplomatic: starts with specific patterns
  const motoPattern = /^[A-Z]{3}\d{2}[A-Z]$/;
  if (motoPattern.test(placa)) {
    return { found: true, clase: 'MOTOCICLETA', dimensions: TIRE_MAP['MOTOCICLETA'] };
  }

  // Standard vehicle plate: 3 letters + 3 digits
  const carPattern = /^[A-Z]{3}\d{3}$/;
  if (carPattern.test(placa)) {
    // Can't determine exact type, but it's a 4+ wheel vehicle
    // Return most common types as suggestions
    return { found: false, dimensions: [] };
  }

  return { found: false, dimensions: [] };
}

// Regional datasets on datos.gov.co with real vehicle plate data
const DATOS_GOV_DATASETS = [
  { id: 'x9pp-pcn5', plateField: 'placa', region: 'Risaralda' },
  { id: 'g7i9-xkxz', plateField: 'placa', region: 'Floridablanca' },
  { id: 'p29a-y4rc', plateField: 'placa', region: 'Cucuta' },
  { id: 'dkxf-ikd7', plateField: 'placa', region: 'Caldas' },
  { id: 'syiu-8mvf', plateField: 'placa', region: 'Barbosa' },
  { id: 'fvnt-frpb', plateField: 'placa', region: 'Transporte publico' },
];

@Injectable()
export class PlateLookupService {
  private readonly logger = new Logger(PlateLookupService.name);
  private cache = new Map<string, { data: any; ts: number }>();
  private readonly CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

  constructor(private readonly prisma: PrismaService) {}

  async lookupPlate(placa: string): Promise<{
    found: boolean;
    source: string;
    placa: string;
    marca?: string;
    linea?: string;
    modelo?: string;
    clase?: string;
    servicio?: string;
    dimensions: string[];
  }> {
    const normalized = placa.toUpperCase().replace(/[^A-Z0-9]/g, '');

    // 1. Check cache
    const cached = this.cache.get(normalized);
    if (cached && Date.now() - cached.ts < this.CACHE_TTL) {
      return cached.data;
    }

    // 2. Check our own DB first
    try {
      const vehicle = await this.prisma.vehicle.findFirst({
        where: { placa: { equals: normalized, mode: 'insensitive' } },
        include: { tires: { select: { dimension: true }, where: { vidaActual: { not: 'fin' } } } },
      });
      if (vehicle) {
        const dims = [...new Set(vehicle.tires.map(t => t.dimension).filter(Boolean))];
        const result = {
          found: true,
          source: 'tirepro',
          placa: normalized,
          clase: vehicle.tipovhc ?? undefined,
          dimensions: dims.length > 0 ? dims : matchVehicleType(vehicle.tipovhc ?? ''),
        };
        this.cache.set(normalized, { data: result, ts: Date.now() });
        return result;
      }
    } catch { /* not found */ }

    // 3. Query all datos.gov.co regional datasets in parallel
    try {
      const govResult = await this.queryDatosGov(normalized);
      if (govResult) {
        const result = {
          found: true,
          source: 'runt',
          placa: normalized,
          marca: govResult.marca,
          linea: govResult.linea,
          modelo: govResult.modelo,
          clase: govResult.clase,
          servicio: govResult.servicio,
          dimensions: matchVehicleType(govResult.clase ?? ''),
        };
        this.cache.set(normalized, { data: result, ts: Date.now() });
        return result;
      }
    } catch (err) {
      this.logger.warn(`datos.gov.co lookup failed for ${normalized}: ${err}`);
    }

    // 4. Try PlacaAPI.co (RegCheck) — paid API, plate-only nationwide lookup
    try {
      const placaApiResult = await this.queryPlacaApi(normalized);
      if (placaApiResult) {
        const result = {
          found: true,
          source: 'runt',
          placa: normalized,
          marca: placaApiResult.marca,
          linea: placaApiResult.linea,
          modelo: placaApiResult.modelo,
          clase: placaApiResult.clase,
          dimensions: matchVehicleType(placaApiResult.clase ?? ''),
        };
        this.cache.set(normalized, { data: result, ts: Date.now() });
        return result;
      }
    } catch (err) {
      this.logger.warn(`PlacaAPI lookup failed for ${normalized}: ${err}`);
    }

    // 5. Infer from plate format (e.g., motorcycle plates)
    const inferred = inferFromPlateFormat(normalized);
    if (inferred.found) {
      const result = {
        found: true,
        source: 'formato',
        placa: normalized,
        clase: inferred.clase,
        dimensions: inferred.dimensions,
      };
      this.cache.set(normalized, { data: result, ts: Date.now() });
      return result;
    }

    // 6. Fallback — not found
    return {
      found: false,
      source: 'none',
      placa: normalized,
      dimensions: [],
    };
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
          if (data && data.length > 0) {
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
      this.logger.log(`Plate ${placa} found in ${found._region} dataset`);
      return found;
    }
    return null;
  }

  /**
   * PlacaAPI.co (RegCheck) — SOAP API for nationwide Colombian plate lookups.
   * Set PLACAAPI_USERNAME env var to enable.
   * 10 free trial lookups, then ~770 COP ($0.20 USD) per lookup.
   * Register at https://www.placaapi.co
   */
  private async queryPlacaApi(placa: string): Promise<{
    marca?: string; linea?: string; modelo?: string; clase?: string;
  } | null> {
    const username = process.env.PLACAAPI_USERNAME;
    if (!username) return null; // Not configured

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:xsd="http://www.w3.org/2001/XMLSchema"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <CheckColombia xmlns="http://regcheck.org.uk">
      <RegistrationNumber>${placa}</RegistrationNumber>
      <username>${username}</username>
    </CheckColombia>
  </soap:Body>
</soap:Envelope>`;

      const res = await fetch('https://www.placaapi.co/api/reg.asmx', {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'SOAPAction': 'http://regcheck.org.uk/CheckColombia',
        },
        body: soapBody,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) return null;

      const xml = await res.text();

      // Parse key fields from the XML response
      const extract = (tag: string): string | undefined => {
        const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
        return match?.[1]?.trim() || undefined;
      };

      // The response nests vehicle data inside <vehicleJson> as JSON or as direct XML fields
      // Try JSON first (vehicleJson field)
      const jsonMatch = xml.match(/<vehicleJson>\s*({[\s\S]*?})\s*<\/vehicleJson>/);
      if (jsonMatch) {
        try {
          const v = JSON.parse(jsonMatch[1]);
          const marca = v.CarMake || v.Make || undefined;
          const linea = v.CarModel || v.Model || undefined;
          const modelo = v.RegistrationYear || v.Year || undefined;
          const clase = v.BodyStyle || v.VehicleType || undefined;
          if (marca || linea) {
            this.logger.log(`PlacaAPI found: ${marca} ${linea} ${modelo}`);
            return { marca, linea, modelo, clase };
          }
        } catch { /* parse failed, try XML */ }
      }

      // Fallback: extract from XML tags directly
      const marca = extract('CarMake') || extract('Make');
      const linea = extract('CarModel') || extract('Model');
      const modelo = extract('RegistrationYear') || extract('Year');
      const clase = extract('BodyStyle') || extract('Description');

      if (marca || linea) {
        this.logger.log(`PlacaAPI found (XML): ${marca} ${linea} ${modelo}`);
        return { marca, linea, modelo, clase };
      }
    } catch (err) {
      this.logger.debug(`PlacaAPI.co request failed: ${err}`);
    }

    return null;
  }
}
