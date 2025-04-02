import { Module } from '@nestjs/common';
import { TireService } from './tire.service';
import { TireController } from './tire.controller';
import { PrismaService } from '../database/prisma.service';

@Module({
  controllers: [TireController],
  providers: [TireService, PrismaService],
  exports: [TireService],
})
export class TireModule {}
