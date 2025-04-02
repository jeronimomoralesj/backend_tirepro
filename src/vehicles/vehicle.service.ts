// src/vehicles/vehicle.service.ts
import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CreateVehicleDto } from './dto/create-vehicle.dto';

@Injectable()
export class VehicleService {
  constructor(private readonly prisma: PrismaService) {}

  async createVehicle(createVehicleDto: CreateVehicleDto) {
    const { placa, kilometrajeActual, carga, pesoCarga, tipovhc, companyId } = createVehicleDto;

    // Check if company exists
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) {
      throw new BadRequestException('Invalid companyId provided');
    }

    // Check for an existing vehicle with the same placa.
    const existingVehicle = await this.prisma.vehicle.findFirst({
      where: { placa },
    });
    if (existingVehicle) {
      throw new BadRequestException('A vehicle with this placa already exists');
    }

    // Create the new vehicle.
    const newVehicle = await this.prisma.vehicle.create({
      data: {
        placa,
        kilometrajeActual,
        carga,
        pesoCarga,
        tipovhc,
        companyId,
        tireCount: 0,
      },
    });

    // Increment the company's vehicleCount by 1.
    await this.prisma.company.update({
      where: { id: companyId },
      data: { vehicleCount: { increment: 1 } },
    });

    return newVehicle;
  }

  async findVehiclesByCompany(companyId: string) {
    return await this.prisma.vehicle.findMany({
      where: { companyId },
    });
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
}
