// src/cupones/cupones.module.ts
import { Module } from '@nestjs/common';
import { CuponesService } from './cupones.service';
import { CuponesController } from './cupones.controller';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  providers: [CuponesService, PrismaService],
  controllers: [CuponesController],
})
export class CuponesModule {}
