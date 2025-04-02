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

  // New endpoint for updating vehicle kilometraje.
  @Patch(':id/kilometraje')
  async updateKilometraje(@Param('id') vehicleId: string, @Body() body: { kilometrajeActual: number }) {
    try {
      const updatedVehicle = await this.vehicleService.updateKilometraje(vehicleId, body.kilometrajeActual);
      return { message: 'Kilometraje updated successfully', vehicle: updatedVehicle };
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }
}
