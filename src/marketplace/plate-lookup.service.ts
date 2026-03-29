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
};

// Fuzzy match vehicle class to our map
function matchVehicleType(clase: string): string[] {
  const upper = (clase ?? '').toUpperCase().trim();
  // Direct match
  if (TIRE_MAP[upper]) return TIRE_MAP[upper];
  // Partial match
  for (const [key, dims] of Object.entries(TIRE_MAP)) {
    if (upper.includes(key) || key.includes(upper)) return dims;
  }
  // Keywords
  if (upper.includes('TRACT') || upper.includes('CABEZOT')) return TIRE_MAP['TRACTOCAMION'];
  if (upper.includes('VOLQU')) return TIRE_MAP['VOLQUETA'];
  if (upper.includes('BUS') && !upper.includes('MICRO')) return TIRE_MAP['BUS'];
  if (upper.includes('MICRO') || upper.includes('BUSET')) return TIRE_MAP['BUSETA'];
  if (upper.includes('CAMION') && !upper.includes('ETA')) return TIRE_MAP['CAMION'];
  if (upper.includes('CAMIONETA') || upper.includes('PICKUP') || upper.includes('PICK')) return TIRE_MAP['PICKUP'];
  if (upper.includes('FURG')) return TIRE_MAP['FURGON'];
  if (upper.includes('CAMP') || upper.includes('SUV') || upper.includes('4X4')) return TIRE_MAP['CAMPERO'];
  if (upper.includes('AUTO') || upper.includes('SEDAN') || upper.includes('HATCH')) return TIRE_MAP['AUTOMOVIL'];
  // Fallback
  return ['295/80R22.5', '11R22.5'];
}

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

    // 3. Try RUNT public consultation
    try {
      const runtResult = await this.queryRunt(normalized);
      if (runtResult) {
        const result = {
          found: true,
          source: 'runt',
          placa: normalized,
          marca: runtResult.marca,
          linea: runtResult.linea,
          modelo: runtResult.modelo,
          clase: runtResult.clase,
          servicio: runtResult.servicio,
          dimensions: matchVehicleType(runtResult.clase ?? ''),
        };
        this.cache.set(normalized, { data: result, ts: Date.now() });
        return result;
      }
    } catch (err) {
      this.logger.warn(`RUNT lookup failed for ${normalized}: ${err}`);
    }

    // 4. Fallback — return not found
    return {
      found: false,
      source: 'none',
      placa: normalized,
      dimensions: [],
    };
  }

  private async queryRunt(placa: string): Promise<{
    marca?: string; linea?: string; modelo?: string; clase?: string; servicio?: string;
  } | null> {
    // Try the RUNT public consultation endpoint
    // This is the same data citizens can freely look up on www.runt.com.co
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(
        `https://www.datos.gov.co/resource/jbjy-vk9h.json?$where=upper(no_placa)='${placa}'&$limit=1`,
        {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'TirePro/1.0',
          },
          signal: controller.signal,
        },
      );
      clearTimeout(timeout);

      if (res.ok) {
        const data = await res.json();
        if (data && data.length > 0) {
          const v = data[0];
          return {
            marca: v.marca ?? v.brand ?? undefined,
            linea: v.linea ?? v.line ?? undefined,
            modelo: v.modelo ?? v.model ?? v.a_o_modelo ?? undefined,
            clase: v.clase_vehiculo ?? v.clase ?? v.vehicle_class ?? undefined,
            servicio: v.tipo_servicio ?? v.servicio ?? undefined,
          };
        }
      }
    } catch (err) {
      this.logger.debug(`datos.gov.co lookup failed: ${err}`);
    }

    // Try alternative open data source
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(
        `https://www.datos.gov.co/resource/a3xd-k4xj.json?$where=upper(placa)='${placa}'&$limit=1`,
        {
          headers: { 'Accept': 'application/json', 'User-Agent': 'TirePro/1.0' },
          signal: controller.signal,
        },
      );
      clearTimeout(timeout);

      if (res.ok) {
        const data = await res.json();
        if (data && data.length > 0) {
          const v = data[0];
          return {
            marca: v.marca ?? undefined,
            linea: v.linea ?? undefined,
            modelo: v.modelo ?? undefined,
            clase: v.clase ?? v.clase_vehiculo ?? undefined,
            servicio: v.servicio ?? undefined,
          };
        }
      }
    } catch (err) {
      this.logger.debug(`Alternative lookup failed: ${err}`);
    }

    return null;
  }
}
