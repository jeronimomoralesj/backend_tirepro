import { 
  Controller, 
  Post, 
  Body, 
  Get, 
  Query, 
  BadRequestException, 
  Patch, 
  Param, 
  UseInterceptors, 
  UploadedFile,
  Delete
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { TireService } from './tire.service';
import { CreateTireDto } from './dto/create-tire.dto';
import { UpdateInspectionDto } from './dto/update-inspection.dto';
import * as multer from 'multer';
import { UpdateVidaDto } from './dto/update-vida.dto';

@Controller('tires')
export class TireController {
  constructor(private readonly tireService: TireService) {}

  @Post('create')
  async createTire(@Body() createTireDto: CreateTireDto) {
    try {
      const tire = await this.tireService.createTire(createTireDto);
      return { message: 'Tire created successfully', tire };
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  @Get()
  async getTires(@Query('companyId') companyId: string) {
    if (!companyId) {
      throw new BadRequestException('companyId is required');
    }
    return await this.tireService.findTiresByCompany(companyId);
  }

  @Get('vehicle')
  async getTiresByVehicle(@Query('vehicleId') vehicleId: string) {
    if (!vehicleId) {
      throw new BadRequestException('vehicleId is required');
    }
    return await this.tireService.findTiresByVehicle(vehicleId);
  }

  @Patch(':id/inspection')
  async updateInspection(
    @Param('id') tireId: string,
    @Body() updateInspectionDto: UpdateInspectionDto
  ) {
    try {
      const updatedTire = await this.tireService.updateInspection(tireId, updateInspectionDto);
      return { message: 'Inspection updated successfully', tire: updatedTire };
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

@Patch(':id/vida')
async updateVida(
  @Param('id') tireId: string,
  @Body() updateVidaDto: UpdateVidaDto
) {
  try {
    const updatedTire = await this.tireService.updateVida(
      tireId, 
      updateVidaDto.valor,
      updateVidaDto.banda,
      updateVidaDto.costo
    );
    return { message: 'Vida updated successfully', tire: updatedTire };
  } catch (error) {
    throw new BadRequestException(error.message);
  }
}

  @Patch(':id/eventos')
async updateEvento(
  @Param('id') tireId: string,
  @Body() updateEventoDto: { valor: string }
) {
  try {
    const updatedTire = await this.tireService.updateEvento(tireId, updateEventoDto.valor);
    return { message: 'Evento agregado exitosamente', tire: updatedTire };
  } catch (error) {
    throw new BadRequestException(error.message);
  }
}

@Post('update-positions')
async updatePositions(@Body() body: { placa: string; updates: { [position: string]: string } }) {
  try {
    const result = await this.tireService.updatePositions(body.placa, body.updates);
    return result;
  } catch (error) {
    throw new BadRequestException(error.message);
  }
}

// Add this to tire.controller.ts

@Get('analyze')
async analyzeTires(@Query('placa') placa: string) {
  if (!placa) {
    throw new BadRequestException('Vehicle placa is required');
  }
  try {
    return await this.tireService.analyzeTires(placa);
  } catch (error) {
    throw new BadRequestException(error.message);
  }
}


@Post('bulk-upload')
@UseInterceptors(FileInterceptor('file', {
  storage: multer.memoryStorage()
}))
async bulkUpload(
  @UploadedFile() file: any,          // → accept `any`
  @Query('companyId') companyId: string
) {
  if (!companyId) {
    throw new BadRequestException('companyId query is required');
  }
  try {
    return await this.tireService.bulkUploadTires(file, companyId);
  } catch (err) {
    throw new BadRequestException(err.message);
  }
}

@Delete(':tireId/inspection')
  deleteInspection(
    @Param('tireId') tireId: string,
    @Query('fecha') fecha: string,
  ) {
    return this.tireService.removeInspection(tireId, fecha);
  }

}
