import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CatalogModule } from '../catalog/catalog.module';
import { TireBenchmarkController } from './tire-benchmark.controller';
import { TireBenchmarkService } from './tire-benchmark.service';

@Module({
  imports:     [PrismaModule, CatalogModule],
  controllers: [TireBenchmarkController],
  providers:   [TireBenchmarkService],
  exports:     [TireBenchmarkService],
})
export class TireBenchmarkModule {}
