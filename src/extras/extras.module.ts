import { Module } from '@nestjs/common';
import { ExtrasService } from './extras.service';
import { ExtrasController } from './extras.controller';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [ExtrasController],
  providers: [ExtrasService, PrismaService],
})
export class ExtrasModule {}
