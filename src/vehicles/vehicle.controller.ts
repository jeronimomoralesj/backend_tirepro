// src/vehicles/vehicle.controller.ts
import { Controller, Post, Body, Get, Query, Delete, Param, BadRequestException, NotFoundException, Patch } from '@nestjs/common';
import { VehicleService } from './vehicle.service';
import { CreateVehicleDto } from './dto/create-vehicle.dto';

@Controller('vehicles')
export class VehicleController {
  constructor(private readonly vehicleService: VehicleService) {}

  @Post('create')
  async createVehicle(@Body() createVehicleDto: CreateVehicleDto) {
    try {
      const vehicle = await this.vehicleService.createVehicle(createVehicleDto);
      return { message: 'Vehicle created successfully', vehicle };
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }
  
  @Get()
  async getVehicles(@Query('companyId') companyId: string) {
    if (!companyId) {
      throw new BadRequestException('companyId is required');
    }
    return await this.vehicleService.findVehiclesByCompany(companyId);
  }

  @Delete(':id')
  async deleteVehicle(@Param('id') id: string) {
    try {
      const deletedVehicle = await this.vehicleService.deleteVehicle(id);
      return { message: 'Vehicle deleted successfully', vehicle: deletedVehicle };
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  @Get('placa')
  async getVehicleByPlaca(@Query('placa') placa: string) {
    if (!placa) {
      throw new NotFoundException('Placa is required');
    }
    return this.vehicleService.findByPlaca(placa);
  }

  // Update vehicle data (for edit functionality)
  @Patch(':id')
  async updateVehicle(
    @Param('id') id: string,
    @Body() updateData: {
      placa?: string;
      kilometrajeActual?: number;
      carga?: string;
      pesoCarga?: number;
      tipovhc?: string;
      cliente?: string | null;
    }
  ) {
    try {
      const vehicle = await this.vehicleService.updateVehicle(id, updateData);
      return { message: 'Vehicle updated successfully', vehicle };
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  // Update vehicle kilometraje (specific endpoint)
  @Patch(':id/kilometraje')
  async updateKilometraje(@Param('id') vehicleId: string, @Body() body: { kilometrajeActual: number }) {
    try {
      const updatedVehicle = await this.vehicleService.updateKilometraje(vehicleId, body.kilometrajeActual);
      return { message: 'Kilometraje updated successfully', vehicle: updatedVehicle };
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  @Patch(':id/union/add')
  async addUnion(
    @Param('id') vehicleId: string,
    @Body('placa') placa: string,
  ) {
    if (!placa) {
      throw new BadRequestException('placa is required');
    }
    try {
      const vehicle = await this.vehicleService.addToUnion(vehicleId, placa);
      return { message: 'Placa added to union', vehicle };
    } catch (err) {
      throw new BadRequestException(err.message);
    }
  }

  @Patch(':id/union/remove')
  async removeUnion(
    @Param('id') vehicleId: string,
    @Body('placa') placa: string,
  ) {
    if (!placa) {
      throw new BadRequestException('placa is required');
    }
    try {
      const vehicle = await this.vehicleService.removeFromUnion(vehicleId, placa);
      return { message: 'Placa removed from union', vehicle };
    } catch (err) {
      throw new BadRequestException(err.message);
    }
  }
  
}