import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
  Inject
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';
import { DriverDto } from './dto/driver.dto';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';

const VEHICLE_SELECT = {
  id:                true,
  placa:             true,
  kilometrajeActual: true,
  carga:             true,
  pesoCarga:         true,
  tipovhc:           true,
  companyId:         true,
  union:             true,
  cliente:           true,
  tipoOperacion:     true,
  configuracion:     true,
  marca:              true,
  kmMensualEstimado:  true,
  kmMensualReal:      true,
  presionesRecomendadas: true,
  presionMin:        true,
  presionMax:        true,
  createdAt:         true,
  updatedAt:         true,
  _count: { select: { tires: true } },
} satisfies Prisma.VehicleSelect;

@Injectable()
export class VehicleService {
  private readonly logger = new Logger(VehicleService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CACHE_MANAGER) private cache: Cache,
  ) {}

  private vehicleKey(companyId: string) {
    return `vehicles:${companyId}`;
  }

  private async invalidateVehicleCache(companyId: string | null | undefined) {
    if (!companyId) return; // orphan vehicles aren't in any company cache
    await this.cache.del(this.vehicleKey(companyId));
  }

  // ── Create ────────────────────────────────────────────────────────────────

  async createVehicle(dto: CreateVehicleDto) {
    const {
      kilometrajeActual, carga, pesoCarga, tipovhc, companyId,
      cliente, tipoOperacion, configuracion, drivers,
      marca, kmMensualEstimado, presionMin, presionMax,
    } = dto;
    if (presionMin != null && presionMax != null && presionMin > presionMax) {
      throw new BadRequestException('presionMin no puede ser mayor que presionMax');
    }
    // Normalize the placa once at the boundary so every downstream
    // lookup, link, and dedupe sees the same casing. Without this the
    // same physical vehicle could be created twice as "ABC123" and
    // "abc123" — the @@unique([companyId, placa]) index treats those
    // as different rows.
    const placa = (dto.placa ?? '').trim().toLowerCase();
    if (!placa) throw new BadRequestException('placa is required');

    const [company, duplicate] = await Promise.all([
      this.prisma.company.findUnique({ where: { id: companyId }, select: { id: true } }),
      // Insensitive match — older rows might still be uppercase from
      // before this normalization, and we don't want to let a duplicate
      // slip in just because the casings differ.
      this.prisma.vehicle.findFirst({
        where:  { placa: { equals: placa, mode: 'insensitive' }, companyId },
        select: { id: true },
      }),
    ]);

    if (!company)  throw new BadRequestException('Invalid companyId provided');
    if (duplicate) throw new BadRequestException('A vehicle with this placa already exists');

    const vehicle = await this.prisma.$transaction(async (tx) => {
      const v = await tx.vehicle.create({
        data: {
          placa,
          kilometrajeActual,
          carga,
          pesoCarga,
          tipovhc,
          companyId,
          cliente:        cliente ?? null,
          tipoOperacion:  tipoOperacion ?? null,
          configuracion:  configuracion ?? null,
          marca:              marca ?? null,
          kmMensualEstimado:  kmMensualEstimado ?? null,
          presionMin:         presionMin ?? null,
          presionMax:         presionMax ?? null,
          union:   [],
        },
        select: VEHICLE_SELECT,
      });

      if (drivers?.length) {
        await tx.vehicleDriver.createMany({
          data: drivers.map((d) => ({
            vehicleId: v.id,
            nombre:    d.nombre,
            telefono:  d.telefono,
            isPrimary: d.isPrimary ?? false,
          })),
        });
      }

      return v;
    });

    await this.invalidateVehicleCache(vehicle.companyId);
    return vehicle;
  }

  // ── Bulk create ───────────────────────────────────────────────────────────
  async bulkCreateVehicles(dtos: CreateVehicleDto[]) {
    const created: any[] = [];
    const failed: { placa: string; error: string }[] = [];
    const companyIdsTouched = new Set<string>();

    // Pre-fetch existing placas for all unique companies in the payload so
    // we can dedupe in O(1) per row instead of one query each. Compare
    // lowercased so an existing row "ABC123" still blocks a new "abc123".
    const companyIds = Array.from(new Set(dtos.map((d) => d.companyId).filter(Boolean)));
    const placas = dtos
      .map((d) => (d.placa ?? '').trim().toLowerCase())
      .filter(Boolean);
    const existing = placas.length > 0
      ? await this.prisma.vehicle.findMany({
          where: { placa: { in: placas }, companyId: { in: companyIds } },
          select: { placa: true, companyId: true },
        })
      : [];
    const existingSet = new Set(existing.map((v) => `${v.companyId}:${v.placa.toLowerCase()}`));
    const seenInBatch = new Set<string>();

    // Validate companies in one shot
    const validCompanies = companyIds.length > 0
      ? await this.prisma.company.findMany({ where: { id: { in: companyIds } }, select: { id: true } })
      : [];
    const validCompanyIds = new Set(validCompanies.map((c) => c.id));

    for (const dto of dtos) {
      const placa = (dto.placa ?? '').trim().toLowerCase();
      if (!placa) { failed.push({ placa: '(vacío)', error: 'Sin placa' }); continue; }
      if (!validCompanyIds.has(dto.companyId)) { failed.push({ placa, error: 'companyId inválido' }); continue; }
      const dedupeKey = `${dto.companyId}:${placa}`;
      if (existingSet.has(dedupeKey) || seenInBatch.has(dedupeKey)) {
        failed.push({ placa, error: 'Una placa con este nombre ya existe' });
        continue;
      }
      seenInBatch.add(dedupeKey);

      try {
        const v = await this.prisma.vehicle.create({
          data: {
            placa,
            kilometrajeActual: dto.kilometrajeActual ?? 0,
            carga: dto.carga ?? 'n/a',
            pesoCarga: dto.pesoCarga ?? 0,
            tipovhc: dto.tipovhc ?? '2_ejes_trailer',
            companyId: dto.companyId,
            cliente: dto.cliente ?? null,
            tipoOperacion: dto.tipoOperacion ?? null,
            configuracion: dto.configuracion ?? null,
            union: [],
          },
          select: VEHICLE_SELECT,
        });
        created.push(v);
        companyIdsTouched.add(dto.companyId);
      } catch (err: any) {
        failed.push({ placa, error: err?.message ?? 'Error inesperado' });
      }
    }

    // Invalidate the cache once per touched company instead of per row.
    await Promise.all(Array.from(companyIdsTouched).map((id) => this.invalidateVehicleCache(id)));

    return { ok: created.length, created, failed };
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  async findVehiclesByCompany(companyId: string) {
    // No cache here on purpose. Every Vehicle row carries _count.tires,
    // which dashboard/vehiculo renders as the live llantas count. Tire
    // assignments mutate that count from many services (tires,
    // inventory-buckets, batch-returns, notifications) and any path that
    // misses an invalidation leaves stale counts in the UI for the full
    // TTL. The query itself is small — a single findMany with one count
    // subquery, indexed by companyId — so the cost of always going to the
    // DB is well below the cost of investigating "why is the count wrong"
    // tickets. If this ever becomes a measurable hotspot, prefer a tighter
    // pub/sub invalidation than re-introducing a TTL cache here.
    return this.prisma.vehicle.findMany({
      // Archived vehicles (no inspections for ≥ 1 year) are kept in the DB
      // for possible reconnection but hidden from every company-scoped view.
      where:   { companyId, archivedAt: null },
      select:  { ...VEHICLE_SELECT, drivers: true },
      orderBy: { placa: 'asc' },
    });
  }

  async findAllVehicles() {
    return this.prisma.vehicle.findMany({
      where:   { archivedAt: null },
      select:  VEHICLE_SELECT,
      orderBy: { placa: 'asc' },
    });
  }

  // Vehicles that users belonging to `companyId` are authorized to inspect.
  // - Pro / fleet company: just the company's own vehicles.
  // - Distribuidor: own vehicles PLUS every client vehicle reachable via
  //   DistributorAccess. Matches the same authorization expansion the
  //   by-placa endpoint already does for the inspection flow, so the
  //   admin picker shows exactly the set their new user will be able to
  //   scope against.
  async findInspectableVehicles(companyId: string) {
    const company = await this.prisma.company.findUnique({
      where:  { id: companyId },
      select: { plan: true },
    });
    let companyIds: string[] = [companyId];
    if (company?.plan === 'distribuidor') {
      const accesses = await this.prisma.distributorAccess.findMany({
        where:  { distributorId: companyId },
        select: { companyId: true },
      });
      companyIds = [companyId, ...accesses.map((a) => a.companyId)];
    }
    return this.prisma.vehicle.findMany({
      where:   { companyId: { in: companyIds }, archivedAt: null },
      select:  { id: true, placa: true, tipovhc: true, companyId: true },
      orderBy: { placa: 'asc' },
    });
  }

  async findByPlaca(placa: string, companyId?: string, accessibleCompanyIds?: string[]) {
    // A placa is only unique WITHIN a company — same sticker number can live
    // on two physical vehicles across different fleets. If the caller knows
    // the company, we must scope by it or we'll silently return a vehicle
    // from the wrong tenant (leading to empty tire lists downstream).
    //
    // Distributors are a special case: they manage many client companies, and
    // the CompanyScopeGuard auto-injects their own companyId (which has zero
    // client vehicles). When `accessibleCompanyIds` is passed, we broaden the
    // search to any of those companies — this is how an authenticated
    // distributor's single-placa lookup resolves without requiring them to
    // pick a client first.
    const where: Prisma.VehicleWhereInput = {
      placa: { equals: placa, mode: 'insensitive' },
      archivedAt: null,
    };
    if (accessibleCompanyIds && accessibleCompanyIds.length > 0) {
      where.companyId = { in: accessibleCompanyIds };
    } else if (companyId) {
      where.companyId = companyId;
    }

    const vehicle = await this.prisma.vehicle.findFirst({
      where,
      select: { ...VEHICLE_SELECT, drivers: true },
    });
    if (!vehicle) {
      throw new NotFoundException(
        companyId
          ? `Vehicle with placa "${placa}" not found for this company`
          : `Vehicle with placa "${placa}" not found`,
      );
    }
    return vehicle;
  }

  // ── Update ────────────────────────────────────────────────────────────────

  async updateVehicle(vehicleId: string, dto: UpdateVehicleDto, callerCompanyId?: string) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where:  { id: vehicleId },
      select: { id: true, placa: true, kilometrajeActual: true, companyId: true, presionMin: true, presionMax: true },
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found');

    if (callerCompanyId && vehicle.companyId !== callerCompanyId) {
      throw new BadRequestException('Vehicle does not belong to your company');
    }

    if (dto.placa && dto.placa !== vehicle.placa) {
      const conflict = await this.prisma.vehicle.findFirst({
        where:  { placa: dto.placa, companyId: vehicle.companyId, id: { not: vehicleId } },
        select: { id: true },
      });
      if (conflict) throw new BadRequestException('A vehicle with this placa already exists');
    }

    if (
      dto.kilometrajeActual !== undefined &&
      dto.kilometrajeActual < vehicle.kilometrajeActual
    ) {
      throw new BadRequestException('El nuevo kilometraje debe ser mayor o igual al actual');
    }

    // Validate the pressure range against the row's resulting values (the
    // incoming value when provided, otherwise the existing one).
    const nextMin = dto.presionMin !== undefined ? dto.presionMin : vehicle.presionMin;
    const nextMax = dto.presionMax !== undefined ? dto.presionMax : vehicle.presionMax;
    if (nextMin != null && nextMax != null && nextMin > nextMax) {
      throw new BadRequestException('presionMin no puede ser mayor que presionMax');
    }

    const updated = await this.prisma.vehicle.update({
  where: { id: vehicleId },
  data:  {
    ...(dto.placa             !== undefined && { placa:             dto.placa.trim().toLowerCase() }),
    ...(dto.kilometrajeActual !== undefined && { kilometrajeActual: dto.kilometrajeActual }),
    ...(dto.carga             !== undefined && { carga:             dto.carga             }),
    ...(dto.pesoCarga         !== undefined && { pesoCarga:         dto.pesoCarga         }),
    ...(dto.tipovhc           !== undefined && { tipovhc:           dto.tipovhc           }),
    ...(dto.cliente           !== undefined && { cliente:           dto.cliente           }),
    ...(dto.tipoOperacion    !== undefined && { tipoOperacion:     dto.tipoOperacion     }),
    ...(dto.configuracion    !== undefined && { configuracion:     dto.configuracion     }),
    ...(dto.marca             !== undefined && { marca:             dto.marca             }),
    ...(dto.kmMensualEstimado !== undefined && { kmMensualEstimado: dto.kmMensualEstimado }),
    ...(dto.presionMin        !== undefined && { presionMin:        dto.presionMin        }),
    ...(dto.presionMax        !== undefined && { presionMax:        dto.presionMax        }),
  },
  select: VEHICLE_SELECT,
});

    await this.invalidateVehicleCache(vehicle.companyId);
    return updated;
  }

  async updateKilometraje(vehicleId: string, newKilometraje: number, callerCompanyId?: string) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where:  { id: vehicleId },
      select: { id: true, kilometrajeActual: true, companyId: true, createdAt: true, kmMensualReal: true },
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found');

    if (callerCompanyId && vehicle.companyId !== callerCompanyId) {
      throw new BadRequestException('Vehicle does not belong to your company');
    }

    if (newKilometraje < vehicle.kilometrajeActual) {
      throw new BadRequestException('El nuevo kilometraje debe ser mayor o igual al actual');
    }

    // kmMensualReal = km gained since tracking started / months tracked.
    // Uses the delta (new - old) over time since creation. Clamped to >= 1
    // month to avoid divide-by-zero on brand-new vehicles.
    const now = new Date();
    const msSinceStart = Math.max(now.getTime() - vehicle.createdAt.getTime(), 30 * 86400_000);
    const monthsTracked = msSinceStart / (30 * 86400_000);
    const kmDelta = Math.max(newKilometraje - (vehicle.kilometrajeActual ?? 0), 0);
    const prevReal = vehicle.kmMensualReal ?? 0;
    const kmMensualReal = prevReal > 0
      ? Math.round(((prevReal + (kmDelta / Math.max(monthsTracked, 1))) / 2) * 100) / 100
      : Math.round((newKilometraje / monthsTracked) * 100) / 100;

    const updated = await this.prisma.vehicle.update({
      where:  { id: vehicleId },
      data:   { kilometrajeActual: newKilometraje, kmMensualReal },
      select: VEHICLE_SELECT,
    });

    await this.invalidateVehicleCache(vehicle.companyId);
    return updated;
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  async deleteVehicle(vehicleId: string, callerCompanyId?: string) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where:  { id: vehicleId },
      select: { id: true, companyId: true },
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found');

    if (callerCompanyId && vehicle.companyId !== callerCompanyId) {
      throw new BadRequestException('Vehicle does not belong to your company');
    }

    const deleted = await this.prisma.vehicle.delete({ where: { id: vehicleId } });
    await this.invalidateVehicleCache(vehicle.companyId); // ← added
    return deleted;
  }

  // ── Union (trailer coupling) ──────────────────────────────────────────────

  async addToUnion(vehicleId: string, otherPlaca: string) {
    // Normalize at the boundary so the case-sensitive "abc123" stored in
    // v1.union still matches against a future "ABC123" remove request.
    // Previously addToUnion stored whatever the caller sent ("ABC123")
    // and removeFromUnion filtered on the same caller string — if the
    // user removed via "abc123" the filter never matched and the link
    // stuck permanently with no UI path to clear it.
    const target = (otherPlaca ?? '').trim().toLowerCase();
    if (!target) throw new BadRequestException('placa is required');

    const [v1, v2] = await Promise.all([
      this.prisma.vehicle.findUnique({
        where:  { id: vehicleId },
        select: { id: true, placa: true, union: true, companyId: true },
      }),
      this.prisma.vehicle.findFirst({
        // Insensitive in case the partner row is still upper-cased from
        // the pre-normalization era.
        where:  { placa: { equals: target, mode: 'insensitive' } },
        select: { id: true, placa: true, union: true, companyId: true },
      }),
    ]);

    if (!v1) throw new NotFoundException(`Vehicle ${vehicleId} not found`);
    if (!v2) throw new NotFoundException(`Vehicle with placa "${otherPlaca}" not found`);
    if (v1.id === v2.id) throw new BadRequestException('Cannot union a vehicle with itself');
    if (v1.companyId !== v2.companyId) {
      throw new BadRequestException('Cannot union vehicles from different companies');
    }

    const v1Placa = v1.placa.toLowerCase();
    const v2Placa = v2.placa.toLowerCase();
    const union1 = (v1.union as string[]).map((p) => p.toLowerCase());
    const union2 = (v2.union as string[]).map((p) => p.toLowerCase());

    if (union1.includes(v2Placa) || union2.includes(v1Placa)) {
      throw new BadRequestException('These vehicles are already united');
    }

    const [updated] = await this.prisma.$transaction([
      this.prisma.vehicle.update({
        where:  { id: v1.id },
        data:   { union: [...union1, v2Placa] },
        select: VEHICLE_SELECT,
      }),
      this.prisma.vehicle.update({
        where: { id: v2.id },
        data:  { union: [...union2, v1Placa] },
      }),
    ]);

    // Invalidate both companies — they may differ if vehicles belong to different companies
    await Promise.all([
      this.invalidateVehicleCache(v1.companyId),
      this.invalidateVehicleCache(v2.companyId),
    ]);
    return updated;
  }

  // ── Drivers ──────────────────────────────────────────────────────────────

  async getDriversForVehicle(vehicleId: string) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where:  { id: vehicleId },
      select: { id: true },
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found');

    return this.prisma.vehicleDriver.findMany({
      where:   { vehicleId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async updateDrivers(vehicleId: string, drivers: DriverDto[]) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where:  { id: vehicleId },
      select: { id: true, companyId: true },
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found');

    await this.prisma.$transaction([
      this.prisma.vehicleDriver.deleteMany({ where: { vehicleId } }),
      this.prisma.vehicleDriver.createMany({
        data: drivers.map((d) => ({
          vehicleId,
          nombre:    d.nombre,
          telefono:  d.telefono,
          isPrimary: d.isPrimary ?? false,
        })),
      }),
    ]);

    await this.invalidateVehicleCache(vehicle.companyId);

    return this.prisma.vehicleDriver.findMany({
      where:   { vehicleId },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ── Union (trailer coupling) ──────────────────────────────────────────────

  async removeFromUnion(vehicleId: string, otherPlaca: string) {
    const target = (otherPlaca ?? '').trim().toLowerCase();
    if (!target) throw new BadRequestException('placa is required');

    const [v1, v2] = await Promise.all([
      this.prisma.vehicle.findUnique({
        where:  { id: vehicleId },
        select: { id: true, placa: true, union: true, companyId: true },
      }),
      this.prisma.vehicle.findFirst({
        where:  { placa: { equals: target, mode: 'insensitive' } },
        select: { id: true, placa: true, union: true, companyId: true },
      }),
    ]);

    if (!v1) throw new NotFoundException(`Vehicle ${vehicleId} not found`);
    if (!v2) throw new NotFoundException(`Vehicle with placa "${otherPlaca}" not found`);

    // Compare lowercased — stale rows from before normalization may
    // still hold mixed-case placas in the union arrays. Without this,
    // a UI "Quitar enlace" click silently no-ops and the user can
    // never unlink the pair.
    const v1Placa = v1.placa.toLowerCase();
    const v2Placa = v2.placa.toLowerCase();
    const union1 = (v1.union as string[]);
    const union2 = (v2.union as string[]);

    if (!union1.some((p) => p.toLowerCase() === v2Placa)) {
      throw new BadRequestException('These vehicles are not currently united');
    }

    const [updated] = await this.prisma.$transaction([
      this.prisma.vehicle.update({
        where:  { id: v1.id },
        data:   { union: union1.filter((p) => p.toLowerCase() !== v2Placa) },
        select: VEHICLE_SELECT,
      }),
      this.prisma.vehicle.update({
        where: { id: v2.id },
        data:  { union: union2.filter((p) => p.toLowerCase() !== v1Placa) },
      }),
    ]);

    await Promise.all([
      this.invalidateVehicleCache(v1.companyId),
      this.invalidateVehicleCache(v2.companyId),
    ]);
    return updated;
  }
}