import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Patch,
  Delete,
} from '@nestjs/common';
import { ExtrasService } from './extras.service';
import { CreateExtraDto } from './dto/create-extra.dto';
import { UpdateExtraDto } from './dto/update-extra.dto';

@Controller()
export class ExtrasController {
  constructor(private readonly extrasService: ExtrasService) {}

  // Create a new extra for a given vehicle
  @Post('vehicles/:vehicleId/extras')
  create(
    @Param('vehicleId') vehicleId: string,
    @Body() dto: CreateExtraDto,
  ) {
    return this.extrasService.create(vehicleId, dto);
  }

  // List all extras for a vehicle
  @Get('vehicles/:vehicleId/extras')
  findAll(@Param('vehicleId') vehicleId: string) {
    return this.extrasService.findAllByVehicle(vehicleId);
  }

  // Get a single extra by its ID
  @Get('extras/:id')
  findOne(@Param('id') id: string) {
    return this.extrasService.findOne(id);
  }

  // Update an extra
  @Patch('extras/:id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateExtraDto,
  ) {
    return this.extrasService.update(id, dto);
  }

  // Delete an extra
  @Delete('extras/:id')
  remove(@Param('id') id: string) {
    return this.extrasService.remove(id);
  }
}
