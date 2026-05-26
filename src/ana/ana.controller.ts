import {
  Controller,
  Post,
  Body,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AnaService } from './ana.service';
import { AnaMessageDto } from './dto/ana-message.dto';

@Controller('ana')
@UseGuards(JwtAuthGuard)
export class AnaController {
  constructor(private readonly anaSvc: AnaService) {}

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
}
