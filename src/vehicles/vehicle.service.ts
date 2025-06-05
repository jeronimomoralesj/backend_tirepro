// src/vehicles/vehicle.service.ts
import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CreateVehicleDto } from './dto/create-vehicle.dto';

@Injectable()
export class VehicleService {
  constructor(private readonly prisma: PrismaService) {}

async createVehicle(createVehicleDto: CreateVehicleDto) {
  const {
    placa,
    kilometrajeActual,
    carga,
    pesoCarga,
    tipovhc,
    companyId,
    cliente,
  } = createVehicleDto;

  console.log("Creating vehicle with data:", { 
    placa, kilometrajeActual, carga, pesoCarga, 
    tipovhc, companyId, cliente 
  });

  // Check company
  const company = await this.prisma.company.findUnique({ where: { id: companyId } });
  if (!company) {
    throw new BadRequestException('Invalid companyId provided');
  }

  // Check for duplicate placa
  const existingVehicle = await this.prisma.vehicle.findFirst({
    where: { placa },
  });
  if (existingVehicle) {
    throw new BadRequestException('A vehicle with this placa already exists');
  }

  try {
    // IMPORTANT: Use Prisma directly to force field inclusion
    const newVehicle = await this.prisma.$transaction(async (prisma) => {
      // Create the vehicle with explicit cliente handling
      const vehicle = await prisma.vehicle.create({
        data: {
          placa,
          kilometrajeActual,
          carga,
          pesoCarga,
          tipovhc,
          companyId,
          cliente: cliente || null,
          tireCount: 0,
          union: [], 
        },
        // Explicitly select all fields to ensure nothing is missed
        select: {
          id: true,
          placa: true,
          kilometrajeActual: true,
          carga: true,
          pesoCarga: true,
          tipovhc: true,
          companyId: true,
          tireCount: true,
          union: true,
          cliente: true,
        }
      });
      
      // Update company count
      await prisma.company.update({
        where: { id: companyId },
        data: { vehicleCount: { increment: 1 } },
      });
      
      return vehicle;
    });

    console.log("Created vehicle:", newVehicle);
    return newVehicle;
  } catch (error) {
    console.error("Error creating vehicle:", error);
    throw error;
  }
}

async findVehiclesByCompany(companyId: string) {
  try {
    const vehicles = await this.prisma.vehicle.findMany({
      where: { companyId },
      // IMPORTANT: Explicitly select all fields including cliente
      select: {
        id: true,
        placa: true,
        kilometrajeActual: true,
        carga: true,
        pesoCarga: true,
        tipovhc: true,
        companyId: true,
        tireCount: true,
        union: true,
        cliente: true,
      }
    });
    
    console.log(`Found ${vehicles.length} vehicles for company ${companyId}`);
    if (vehicles.length > 0) {
      console.log('Sample vehicle:', vehicles[0]);
      console.log('Cliente value:', vehicles[0].cliente);
    }
    
    return vehicles;
  } catch (error) {
    console.error('Error fetching vehicles:', error);
    throw error;
  }
}

  async deleteVehicle(vehicleId: string) {
    // Find the vehicle first
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
    });
    if (!vehicle) {
      throw new BadRequestException('Vehicle not found');
    }

    // Decrement the company's vehicleCount by 1.
    await this.prisma.company.update({
      where: { id: vehicle.companyId },
      data: { vehicleCount: { decrement: 1 } },
    });

    // Delete the vehicle.
    return await this.prisma.vehicle.delete({
      where: { id: vehicleId },
    });
  }

  async findByPlaca(placa: string) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { placa },
    });
    if (!vehicle) {
      throw new NotFoundException(`Vehicle with placa ${placa} not found`);
    }
    return vehicle;
  }

  async updateKilometraje(vehicleId: string, newKilometraje: number) {
    // Find the vehicle.
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
    });
    if (!vehicle) {
      throw new NotFoundException('Vehicle not found');
    }
    if (newKilometraje < vehicle.kilometrajeActual) {
      throw new BadRequestException('El nuevo kilometraje debe ser mayor o igual al actual');
    }
    // Update the vehicle's kilometrajeActual.
    return await this.prisma.vehicle.update({
      where: { id: vehicleId },
      data: { kilometrajeActual: newKilometraje },
    });
  }

  async addToUnion(vehicleId: string, otherPlaca: string) {
    // 1. Load both vehicles
    const [v1, v2] = await Promise.all([
      this.prisma.vehicle.findUnique({ where: { id: vehicleId } }),
      this.prisma.vehicle.findFirst({ where: { placa: otherPlaca } })
    ]);
    if (!v1) throw new NotFoundException(`Vehicle ${vehicleId} not found`);
    if (!v2) throw new NotFoundException(`Vehicle with placa ${otherPlaca} not found`);

    // 2. Prevent self‐linking or duplicates
    if (v1.id === v2.id) {
      throw new BadRequestException(`Cannot union a vehicle with itself`);
    }
    const union1 = v1.union as string[];
    const union2 = v2.union as string[];
    if (union1.includes(v2.placa) || union2.includes(v1.placa)) {
      throw new BadRequestException('These vehicles are already united');
    }

    // 3. Perform both updates in a single transaction
    const [updated1, updated2] = await this.prisma.$transaction([
      this.prisma.vehicle.update({
        where: { id: v1.id },
        data: { union: [...union1, v2.placa] }
      }),
      this.prisma.vehicle.update({
        where: { id: v2.id },
        data: { union: [...union2, v1.placa] }
      })
    ]);

    return updated1;
  }

  async removeFromUnion(vehicleId: string, otherPlaca: string) {
    // 1. Load both vehicles
    const [v1, v2] = await Promise.all([
      this.prisma.vehicle.findUnique({ where: { id: vehicleId } }),
      this.prisma.vehicle.findFirst({ where: { placa: otherPlaca } })
    ]);
    if (!v1) throw new NotFoundException(`Vehicle ${vehicleId} not found`);
    if (!v2) throw new NotFoundException(`Vehicle with placa ${otherPlaca} not found`);

    const union1 = v1.union as string[];
    const union2 = v2.union as string[];
    if (!union1.includes(v2.placa) || !union2.includes(v1.placa)) {
      throw new BadRequestException('These vehicles are not currently united');
    }

    // 2. Remove each from the other’s union array
    const newUnion1 = union1.filter((p) => p !== v2.placa);
    const newUnion2 = union2.filter((p) => p !== v1.placa);

    // 3. Update both in one transaction
    const [updated1] = await this.prisma.$transaction([
      this.prisma.vehicle.update({
        where: { id: v1.id },
        data: { union: newUnion1 }
      }),
      this.prisma.vehicle.update({
        where: { id: v2.id },
        data: { union: newUnion2 }
      })
    ]);

    return updated1;
  }
}