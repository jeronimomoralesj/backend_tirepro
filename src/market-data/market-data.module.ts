import { Module } from '@nestjs/common';
import { MarketDataController } from './market-data.controller';
import { MarketDataService } from './market-data.service';
import { PrismaService } from '../prisma/prisma.service'; // Adjust path as needed

@Module({
  controllers: [MarketDataController],
  providers: [MarketDataService, PrismaService],
  exports: [MarketDataService],
})
export class MarketDataModule {}