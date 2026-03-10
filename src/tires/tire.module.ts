import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TireService } from './tire.service';
import { TireController } from './tire.controller';
import { S3Service } from './s3.service';
import { PrismaService } from '../prisma/prisma.service';
import { VehicleModule } from '../vehicles/vehicle.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    ConfigModule,
    VehicleModule,
    NotificationsModule,
    // MarketDataModule removed — replaced by tire_benchmarks materialized view
  ],
  controllers: [TireController],
  providers: [TireService, S3Service, PrismaService],
  exports: [TireService],
})
export class TireModule {}