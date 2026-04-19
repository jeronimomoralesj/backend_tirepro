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

  private async invalidateVehicleCache(companyId: string) {
    await this.cache.del(this.vehicleKey(companyId));
  }

  // ── Create ────────────────────────────────────────────────────────────────

  async createVehicle(dto: CreateVehicleDto) {
    const {
      placa, kilometrajeActual, carga, pesoCarga, tipovhc, companyId,
      cliente, tipoOperacion, configuracion, drivers,
      marca, kmMensualEstimado,
    } = dto;

    const [company, duplicate] = await Promise.all([
      this.prisma.company.findUnique({ where: { id: companyId }, select: { id: true } }),
      this.prisma.vehicle.findFirst({ where: { placa }, select: { id: true } }),
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
    // we can dedupe in O(1) per row instead of one query each.
    const placas = dtos.map((d) => d.placa).filter(Boolean);
    const existing = placas.length > 0
      ? await this.prisma.vehicle.findMany({ where: { placa: { in: placas } }, select: { placa: true } })
      : [];
    const existingSet = new Set(existing.map((v) => v.placa));
    const seenInBatch = new Set<string>();

    // Validate companies in one shot
    const companyIds = Array.from(new Set(dtos.map((d) => d.companyId).filter(Boolean)));
    const validCompanies = companyIds.length > 0
      ? await this.prisma.company.findMany({ where: { id: { in: companyIds } }, select: { id: true } })
      : [];
    const validCompanyIds = new Set(validCompanies.map((c) => c.id));

    for (const dto of dtos) {
      const placa = (dto.placa ?? '').trim();
      if (!placa) { failed.push({ placa: '(vacío)', error: 'Sin placa' }); continue; }
      if (!validCompanyIds.has(dto.companyId)) { failed.push({ placa, error: 'companyId inválido' }); continue; }
      if (existingSet.has(placa) || seenInBatch.has(placa)) {
        failed.push({ placa, error: 'Una placa con este nombre ya existe' });
        continue;
      }
      seenInBatch.add(placa);

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
    const cached = await this.cache.get(this.vehicleKey(companyId));
    if (cached) return cached;

    const vehicles = await this.prisma.vehicle.findMany({
      // Archived vehicles (no inspections for ≥ 1 year) are kept in the DB
      // for possible reconnection but hidden from every company-scoped view.
      where:   { companyId, archivedAt: null },
      select:  { ...VEHICLE_SELECT, drivers: true },
      orderBy: { placa: 'asc' },
    });

    await this.cache.set(this.vehicleKey(companyId), vehicles, 60 * 60 * 1000);
    return vehicles;
  }

  async findAllVehicles() {
    return this.prisma.vehicle.findMany({
      where:   { archivedAt: null },
      select:  VEHICLE_SELECT,
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

  async updateVehicle(vehicleId: string, dto: UpdateVehicleDto) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where:  { id: vehicleId },
      select: { id: true, placa: true, kilometrajeActual: true, companyId: true }, // ← companyId added
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found');

    if (dto.placa && dto.placa !== vehicle.placa) {
      const conflict = await this.prisma.vehicle.findFirst({
        where:  { placa: dto.placa, id: { not: vehicleId } },
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

    const updated = await this.prisma.vehicle.update({
  where: { id: vehicleId },
  data:  {
    ...(dto.placa             !== undefined && { placa:             dto.placa             }),
    ...(dto.kilometrajeActual !== undefined && { kilometrajeActual: dto.kilometrajeActual }),
    ...(dto.carga             !== undefined && { carga:             dto.carga             }),
    ...(dto.pesoCarga         !== undefined && { pesoCarga:         dto.pesoCarga         }),
    ...(dto.tipovhc           !== undefined && { tipovhc:           dto.tipovhc           }),
    ...(dto.cliente           !== undefined && { cliente:           dto.cliente           }),
    ...(dto.tipoOperacion    !== undefined && { tipoOperacion:     dto.tipoOperacion     }),
    ...(dto.configuracion    !== undefined && { configuracion:     dto.configuracion     }),
    ...(dto.marca             !== undefined && { marca:             dto.marca             }),
    ...(dto.kmMensualEstimado !== undefined && { kmMensualEstimado: dto.kmMensualEstimado }),
    ...(dto.companyId         !== undefined && { companyId:         dto.companyId         }),
  },
  select: VEHICLE_SELECT,
});

// Invalidate BOTH old and new company caches if company changed
if (dto.companyId && dto.companyId !== vehicle.companyId) {
  await this.invalidateVehicleCache(dto.companyId);  // ← ADD
}
await this.invalidateVehicleCache(vehicle.companyId);

    await this.invalidateVehicleCache(vehicle.companyId); // ← added
    return updated;
  }

  async updateKilometraje(vehicleId: string, newKilometraje: number) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where:  { id: vehicleId },
      select: { id: true, kilometrajeActual: true, companyId: true, createdAt: true },
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found');

    if (newKilometraje < vehicle.kilometrajeActual) {
      throw new BadRequestException('El nuevo kilometraje debe ser mayor o igual al actual');
    }

    // kmMensualReal = total km accumulated by this vehicle / months tracked.
    // We use createdAt as the start anchor because we don't have a separate
    // "fecha ingreso" column. Months are clamped to >= 1 to avoid divide-by-
    // zero on brand-new vehicles.
    const now = new Date();
    const msSinceStart = Math.max(now.getTime() - vehicle.createdAt.getTime(), 30 * 86400_000);
    const monthsTracked = msSinceStart / (30 * 86400_000);
    const kmMensualReal = Math.round((newKilometraje / monthsTracked) * 100) / 100;

    const updated = await this.prisma.vehicle.update({
      where:  { id: vehicleId },
      data:   { kilometrajeActual: newKilometraje, kmMensualReal },
      select: VEHICLE_SELECT,
    });

    await this.invalidateVehicleCache(vehicle.companyId);
    return updated;
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  async deleteVehicle(vehicleId: string) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where:  { id: vehicleId },
      select: { id: true, companyId: true },
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found');

    const deleted = await this.prisma.vehicle.delete({ where: { id: vehicleId } });
    await this.invalidateVehicleCache(vehicle.companyId); // ← added
    return deleted;
  }

  // ── Union (trailer coupling) ──────────────────────────────────────────────

  async addToUnion(vehicleId: string, otherPlaca: string) {
    const [v1, v2] = await Promise.all([
      this.prisma.vehicle.findUnique({
        where:  { id: vehicleId },
        select: { id: true, placa: true, union: true, companyId: true }, // ← companyId added
      }),
      this.prisma.vehicle.findFirst({
        where:  { placa: otherPlaca },
        select: { id: true, placa: true, union: true, companyId: true }, // ← companyId added
      }),
    ]);

    if (!v1) throw new NotFoundException(`Vehicle ${vehicleId} not found`);
    if (!v2) throw new NotFoundException(`Vehicle with placa "${otherPlaca}" not found`);
    if (v1.id === v2.id) throw new BadRequestException('Cannot union a vehicle with itself');

    const union1 = v1.union as string[];
    const union2 = v2.union as string[];

    if (union1.includes(v2.placa) || union2.includes(v1.placa)) {
      throw new BadRequestException('These vehicles are already united');
    }

    const [updated] = await this.prisma.$transaction([
      this.prisma.vehicle.update({
        where:  { id: v1.id },
        data:   { union: [...union1, v2.placa] },
        select: VEHICLE_SELECT,
      }),
      this.prisma.vehicle.update({
        where: { id: v2.id },
        data:  { union: [...union2, v1.placa] },
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
    const [v1, v2] = await Promise.all([
      this.prisma.vehicle.findUnique({
        where:  { id: vehicleId },
        select: { id: true, placa: true, union: true, companyId: true }, // ← companyId added
      }),
      this.prisma.vehicle.findFirst({
        where:  { placa: otherPlaca },
        select: { id: true, placa: true, union: true, companyId: true }, // ← companyId added
      }),
    ]);

    if (!v1) throw new NotFoundException(`Vehicle ${vehicleId} not found`);
    if (!v2) throw new NotFoundException(`Vehicle with placa "${otherPlaca}" not found`);

    const union1 = v1.union as string[];
    const union2 = v2.union as string[];

    if (!union1.includes(v2.placa)) {
      throw new BadRequestException('These vehicles are not currently united');
    }

    const [updated] = await this.prisma.$transaction([
      this.prisma.vehicle.update({
        where:  { id: v1.id },
        data:   { union: union1.filter(p => p !== v2.placa) },
        select: VEHICLE_SELECT,
      }),
      this.prisma.vehicle.update({
        where: { id: v2.id },
        data:  { union: union2.filter(p => p !== v1.placa) },
      }),
    ]);

    await Promise.all([
      this.invalidateVehicleCache(v1.companyId),
      this.invalidateVehicleCache(v2.companyId),
    ]);
    return updated;
  }
}