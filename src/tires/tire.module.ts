import { Module } from '@nestjs/common';
import { TireService } from './tire.service';
import { TireController } from './tire.controller';
import { PrismaService } from '../database/prisma.service';
import { VehicleModule } from 'src/vehicles/vehicle.module';
import { NotificationsModule } from 'src/notifications/notifications.module';
import { MarketDataModule } from 'src/market-data/market-data.module';

@Module({
  imports: [VehicleModule, NotificationsModule, MarketDataModule],
  controllers: [TireController],
  providers: [TireService, PrismaService],
  exports: [TireService],
})
export class TireModule {}
