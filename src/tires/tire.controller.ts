import {
  Controller,
  Post,
  Body,
  Get,
  Query,
  Patch,
  Param,
  Delete,
  UseInterceptors,
  UploadedFile,
  HttpCode,
  HttpStatus,
  UsePipes,
  ValidationPipe,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CompanyScopeGuard } from '../auth/guards/company-scope.guard';
import { EditTireDto, TireService } from './tire.service';
import { TireProjectionService } from './tire-projection.service';
import { CreateTireDto } from './dto/create-tire.dto';
import { UpdateInspectionDto } from './dto/update-inspection.dto';
import { EditInspectionDto } from './dto/edit-inspection.dto';
import { UpdateVidaDto } from './dto/update-vida.dto';
import { UpdateEventoDto } from './dto/update-evento.dto';

@Controller('tires')
@UseGuards(JwtAuthGuard, CompanyScopeGuard)
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
export class TireController {
  constructor(
    private readonly tireService: TireService,
    private readonly tireProjectionService: TireProjectionService,
  ) {}

  // ── Create ────────────────────────────────────────────────────────────────

  @Post('create')
  @HttpCode(HttpStatus.CREATED)
  createTire(@Body() dto: CreateTireDto) {
    return this.tireService.createTire(dto);
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  @Get()
  getTires(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.tireService.findTiresByCompany(companyId);
  }

  @Get('all')
  getAllTires() {
    return this.tireService.findAllTires();
  }

  @Get('vehicle')
  getTiresByVehicle(@Query('vehicleId') vehicleId: string) {
    if (!vehicleId) throw new BadRequestException('vehicleId is required');
    return this.tireService.findTiresByVehicle(vehicleId);
  }

  @Get('analyze')
  analyzeTires(@Query('placa') placa: string) {
    if (!placa) throw new BadRequestException('Vehicle placa is required');
    return this.tireService.analyzeTires(placa);
  }

  @Get(':id')
  getTireById(@Param('id') id: string) {
    return this.tireService.findTireById(id);
  }

  // ── Projections ─────────────────────────────────────────────────────────

  @Post('projections/update')
  async updateProjections() {
    await this.tireProjectionService.updateAllProjections();
    return { message: 'Projections updated' };
  }

  // ── Bulk upload ───────────────────────────────────────────────────────────

  @Post('bulk-upload')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  bulkUpload(
    @UploadedFile() file: Express.Multer.File,
    @Query('companyId') companyId: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    if (!file?.buffer) throw new BadRequestException('No file received');
    return this.tireService.bulkUploadTires(file, companyId);
  }

  // ── Assign / unassign ─────────────────────────────────────────────────────

  @Post('assign-vehicle')
  @HttpCode(HttpStatus.OK)
  assignVehicle(@Body() body: { vehiclePlaca: string; tireIds: string[] }) {
    return this.tireService.assignTiresToVehicle(body.vehiclePlaca, body.tireIds);
  }

  @Post('unassign-vehicle')
  @HttpCode(HttpStatus.OK)
  unassignVehicle(@Body() body: { tireIds: string[] }) {
    return this.tireService.unassignTiresFromVehicle(body.tireIds);
  }

  @Post('update-positions')
  @HttpCode(HttpStatus.OK)
  updatePositions(@Body() body: { placa: string; updates: Record<string, string | string[]> }) {
    return this.tireService.updatePositions(body.placa, body.updates);
  }

  // ── Tire mutations ────────────────────────────────────────────────────────

  @Patch(':id/inspection')
  updateInspection(
    @Param('id') tireId: string,
    @Body() dto: UpdateInspectionDto,
  ) {
    return this.tireService.updateInspection(tireId, dto);
  }

  @Patch(':id/vida')
  updateVida(
    @Param('id') tireId: string,
    @Body() dto: UpdateVidaDto,
  ) {
    return this.tireService.updateVida(
      tireId,
      dto.valor,
      dto.banda,
      dto.costo,
      dto.profundidadInicial,
      dto.proveedor,
      // Merge desechos body + imageUrls into the single desechoData param
      dto.desechos
        ? { ...dto.desechos, imageUrls: dto.imageUrls }
        : undefined,
      dto.bandaMarca,   // ← was missing
      dto.motivoFin,    // ← was missing
      dto.notasRetiro,  // ← was missing
    );
  }

  @Patch(':id/eventos')
  updateEvento(
    @Param('id') tireId: string,
    @Body() dto: UpdateEventoDto,
  ) {
    return this.tireService.updateEvento(tireId, dto.valor);
  }

  @Patch(':id/edit')
  editTire(
    @Param('id') tireId: string,
    @Body() dto: EditTireDto,
  ) {
    return this.tireService.editTire(tireId, dto);
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  @Patch(':tireId/inspection/edit')
  editInspection(
    @Param('tireId') tireId: string,
    @Query('fecha') fecha: string,
    @Body() dto: EditInspectionDto,
  ) {
    if (!fecha) throw new BadRequestException('fecha query param is required');
    return this.tireService.editInspection(tireId, fecha, dto);
  }

  @Delete(':tireId/inspection')
  @HttpCode(HttpStatus.OK)
  deleteInspection(
    @Param('tireId') tireId: string,
    @Query('fecha') fecha: string,
  ) {
    if (!fecha) throw new BadRequestException('fecha query param is required');
    return this.tireService.removeInspection(tireId, fecha);
  }
}