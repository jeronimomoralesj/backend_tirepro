import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { AnaService } from './ana.service';
import { AnaMessageDto } from './dto/ana-message.dto';

@Controller('ana')
@UseGuards(JwtAuthGuard)
export class AnaController {
  constructor(
    private readonly anaSvc: AnaService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('chat')
  @HttpCode(HttpStatus.OK)
  @SkipThrottle()
  async chat(
    @Req() req: { user?: { companyId?: string } },
    @Body() dto: AnaMessageDto,
  ) {
    const companyId = req.user?.companyId;
    if (!companyId) {
      throw new BadRequestException('No company associated with this user.');
    }

    try {
      return await this.anaSvc.chat(
        companyId,
        dto.message,
        dto.history ?? [],
        dto.tireData ?? '',
      );
    } catch {
      throw new InternalServerErrorException(
        'No se pudo conectar con Ana. Intenta de nuevo.',
      );
    }
  }

  @Get('vehicle-tires')
  @SkipThrottle()
  async vehicleTires(
    @Req() req: { user?: { companyId?: string } },
    @Query('placa') placa: string,
  ) {
    const companyId = req.user?.companyId;
    if (!companyId) throw new BadRequestException('No company.');
    if (!placa?.trim()) throw new BadRequestException('placa is required.');

    const vehicle = await this.prisma.vehicle.findFirst({
      where: {
        companyId,
        placa: { equals: placa.trim(), mode: 'insensitive' },
        archivedAt: null,
      },
      select: {
        id: true,
        placa: true,
        tipovhc: true,
        kilometrajeActual: true,
        configuracion: true,
        tires: {
          select: {
            id: true,
            placa: true,
            marca: true,
            diseno: true,
            dimension: true,
            eje: true,
            posicion: true,
            currentProfundidad: true,
            profundidadInicial: true,
            vidaActual: true,
            alertLevel: true,
            healthScore: true,
          },
          orderBy: { posicion: 'asc' },
        },
      },
    });

    if (!vehicle) throw new NotFoundException('Vehículo no encontrado.');
    return vehicle;
  }
}
