import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';

// ---------------------------------------------------------------------------
// Reusable select — never fetch more columns than the caller needs.
// tireCount removed: derived live via _count to avoid stale cached integers.
// ---------------------------------------------------------------------------
const VEHICLE_SELECT = {
  id:               true,
  placa:            true,
  kilometrajeActual: true,
  carga:            true,
  pesoCarga:        true,
  tipovhc:          true,
  companyId:        true,
  union:            true,
  cliente:          true,
  createdAt:        true,
  updatedAt:        true,
  _count: { select: { tires: true } },
} satisfies Prisma.VehicleSelect;

@Injectable()
export class VehicleService {
  private readonly logger = new Logger(VehicleService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Create ────────────────────────────────────────────────────────────────

  async createVehicle(dto: CreateVehicleDto) {
    const { placa, kilometrajeActual, carga, pesoCarga, tipovhc, companyId, cliente } = dto;

    // Validate company + check duplicate placa in parallel
    const [company, duplicate] = await Promise.all([
      this.prisma.company.findUnique({ where: { id: companyId }, select: { id: true } }),
      this.prisma.vehicle.findFirst({ where: { placa }, select: { id: true } }),
    ]);

    if (!company)   throw new BadRequestException('Invalid companyId provided');
    if (duplicate)  throw new BadRequestException('A vehicle with this placa already exists');

    const vehicle = await this.prisma.vehicle.create({
      data: {
        placa,
        kilometrajeActual,
        carga,
        pesoCarga,
        tipovhc,
        companyId,
        cliente: cliente ?? null,
        union:   [],
      },
      select: VEHICLE_SELECT,
    });

    return vehicle;
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  async findVehiclesByCompany(companyId: string) {
    return this.prisma.vehicle.findMany({
      where:   { companyId },
      select:  VEHICLE_SELECT,
      orderBy: { placa: 'asc' },
    });
  }

  async findAllVehicles() {
    return this.prisma.vehicle.findMany({
      select:  VEHICLE_SELECT,
      orderBy: { placa: 'asc' },
    });
  }

  async findByPlaca(placa: string) {
  const vehicle = await this.prisma.vehicle.findFirst({
    where: {
      placa: { equals: placa, mode: 'insensitive' }
    },
    select: VEHICLE_SELECT,
  });
  if (!vehicle) throw new NotFoundException(`Vehicle with placa "${placa}" not found`);
  return vehicle;
}

  // ── Update ────────────────────────────────────────────────────────────────

  async updateVehicle(vehicleId: string, dto: UpdateVehicleDto) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where:  { id: vehicleId },
      select: { id: true, placa: true, kilometrajeActual: true },
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found');

    // Placa uniqueness check — only needed when it actually changes
    if (dto.placa && dto.placa !== vehicle.placa) {
      const conflict = await this.prisma.vehicle.findFirst({
        where:  { placa: dto.placa, id: { not: vehicleId } },
        select: { id: true },
      });
      if (conflict) throw new BadRequestException('A vehicle with this placa already exists');
    }

    // Odometer can never go backwards
    if (
      dto.kilometrajeActual !== undefined &&
      dto.kilometrajeActual < vehicle.kilometrajeActual
    ) {
      throw new BadRequestException('El nuevo kilometraje debe ser mayor o igual al actual');
    }

    return this.prisma.vehicle.update({
      where: { id: vehicleId },
      data:  {
        ...(dto.placa             !== undefined && { placa:             dto.placa             }),
        ...(dto.kilometrajeActual !== undefined && { kilometrajeActual: dto.kilometrajeActual }),
        ...(dto.carga             !== undefined && { carga:             dto.carga             }),
        ...(dto.pesoCarga         !== undefined && { pesoCarga:         dto.pesoCarga         }),
        ...(dto.tipovhc           !== undefined && { tipovhc:           dto.tipovhc           }),
        ...(dto.cliente           !== undefined && { cliente:           dto.cliente           }),
      },
      select: VEHICLE_SELECT,
    });
  }

  async updateKilometraje(vehicleId: string, newKilometraje: number) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where:  { id: vehicleId },
      select: { id: true, kilometrajeActual: true },
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found');

    if (newKilometraje < vehicle.kilometrajeActual) {
      throw new BadRequestException('El nuevo kilometraje debe ser mayor o igual al actual');
    }

    return this.prisma.vehicle.update({
      where:  { id: vehicleId },
      data:   { kilometrajeActual: newKilometraje },
      select: VEHICLE_SELECT,
    });
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  async deleteVehicle(vehicleId: string) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where:  { id: vehicleId },
      select: { id: true, companyId: true },
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found');

    // Cascade delete handled by Prisma schema (onDelete: Cascade on tires).
    // No manual tireCount decrement needed — that column is removed from schema.
    return this.prisma.vehicle.delete({ where: { id: vehicleId } });
  }

  // ── Union (trailer coupling) ──────────────────────────────────────────────

  async addToUnion(vehicleId: string, otherPlaca: string) {
    const [v1, v2] = await Promise.all([
      this.prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { id: true, placa: true, union: true } }),
      this.prisma.vehicle.findFirst({ where: { placa: otherPlaca }, select: { id: true, placa: true, union: true } }),
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

    return updated;
  }

  async removeFromUnion(vehicleId: string, otherPlaca: string) {
    const [v1, v2] = await Promise.all([
      this.prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { id: true, placa: true, union: true } }),
      this.prisma.vehicle.findFirst({ where: { placa: otherPlaca }, select: { id: true, placa: true, union: true } }),
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

    return updated;
  }
}