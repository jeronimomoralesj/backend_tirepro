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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { VehicleService } from './vehicle.service';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';
import { UpdateKilometrajeDto } from './dto/update-kilometraje.dto';
import { UnionDto } from './dto/union.dto';

@Controller('vehicles')
@UseGuards(JwtAuthGuard)
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

  // ── Delete ────────────────────────────────────────────────────────────────

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  deleteVehicle(@Param('id') id: string) {
    return this.vehicleService.deleteVehicle(id);
  }
}