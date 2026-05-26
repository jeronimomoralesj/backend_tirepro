import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { AnaService } from './ana.service';
import { AnaMessageDto } from './dto/ana-message.dto';

@Controller('ana')
export class AnaController {
  constructor(private readonly anaSvc: AnaService) {}

  @Post('chat')
  @HttpCode(HttpStatus.OK)
  @SkipThrottle()
  async chat(@Body() dto: AnaMessageDto) {
    try {
      return await this.anaSvc.chat(
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
