import {
  Controller,
  Post,
  Body,
  Get,
  Query,
  Delete,
  Param,
  Patch,
  HttpCode,
  HttpStatus,
  UseGuards,
  UsePipes,
  ValidationPipe,
  BadRequestException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CompanyScopeGuard } from '../auth/guards/company-scope.guard';
import { VehicleService } from './vehicle.service';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';
import { UpdateKilometrajeDto } from './dto/update-kilometraje.dto';
import { UnionDto } from './dto/union.dto';
import { DriverDto } from './dto/driver.dto';
import { IsArray, ArrayMaxSize, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class UpdateDriversDto {
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => DriverDto)
  drivers: DriverDto[];
}

@Controller('vehicles')
@UseGuards(JwtAuthGuard, CompanyScopeGuard)
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
export class VehicleController {
  constructor(private readonly vehicleService: VehicleService) {}

  // ── Static routes first (before :id param routes) ────────────────────────

  @Get('all')
  findAll() {
    return this.vehicleService.findAllVehicles();
  }

  @Get('by-placa')
getByPlaca(@Query('placa') placa: string) {  // ← 'placa' not 'by-placa'
  if (!placa) throw new BadRequestException('placa query param is required');
  return this.vehicleService.findByPlaca(placa);
}


  // ── Create ────────────────────────────────────────────────────────────────

  @Post('create')
  @HttpCode(HttpStatus.CREATED)
  createVehicle(@Body() dto: CreateVehicleDto) {
    return this.vehicleService.createVehicle(dto);
  }

  // Bulk vehicle creation. Sent as a single request so the throttler only
  // counts it once. The frontend uses this for the carga masiva flow.
  // Returns { ok: number, failed: { placa, error }[] } so the UI can show
  // which rows succeeded and which need fixing.
  @Post('bulk-create')
  @SkipThrottle()
  @HttpCode(HttpStatus.OK)
  async bulkCreateVehicles(@Body() body: { vehicles: CreateVehicleDto[] }) {
    if (!Array.isArray(body?.vehicles) || body.vehicles.length === 0) {
      throw new BadRequestException('vehicles array is required');
    }
    if (body.vehicles.length > 500) {
      throw new BadRequestException('Maximum 500 vehicles per bulk request');
    }
    return this.vehicleService.bulkCreateVehicles(body.vehicles);
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  @Get()
  getVehicles(@Query('companyId') companyId: string) {
    if (!companyId) throw new Error('companyId is required');
    return this.vehicleService.findVehiclesByCompany(companyId);
  }

  // ── Update ────────────────────────────────────────────────────────────────

  @Patch(':id')
  updateVehicle(
    @Param('id') id: string,
    @Body() dto: UpdateVehicleDto,
  ) {
    return this.vehicleService.updateVehicle(id, dto);
  }

  @Patch(':id/kilometraje')
  updateKilometraje(
    @Param('id') id: string,
    @Body() dto: UpdateKilometrajeDto,
  ) {
    return this.vehicleService.updateKilometraje(id, dto.kilometrajeActual);
  }

  @Patch(':id/union/add')
  @HttpCode(HttpStatus.OK)
  addUnion(
    @Param('id') vehicleId: string,
    @Body() dto: UnionDto,
  ) {
    return this.vehicleService.addToUnion(vehicleId, dto.placa);
  }

  @Patch(':id/union/remove')
  @HttpCode(HttpStatus.OK)
  removeUnion(
    @Param('id') vehicleId: string,
    @Body() dto: UnionDto,
  ) {
    return this.vehicleService.removeFromUnion(vehicleId, dto.placa);
  }

  // ── Drivers ──────────────────────────────────────────────────────────────

  @Get(':id/drivers')
  getDrivers(@Param('id') id: string) {
    return this.vehicleService.getDriversForVehicle(id);
  }

  @Patch(':id/drivers')
  updateDrivers(
    @Param('id') id: string,
    @Body() dto: UpdateDriversDto,
  ) {
    return this.vehicleService.updateDrivers(id, dto.drivers);
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  deleteVehicle(@Param('id') id: string) {
    return this.vehicleService.deleteVehicle(id);
  }
}