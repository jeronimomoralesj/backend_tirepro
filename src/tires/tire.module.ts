import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TireService } from './tire.service';
import { TireProjectionService } from './tire-projection.service';
import { TireController } from './tire.controller';
import { S3Service } from './s3.service';
import { PrismaService } from '../prisma/prisma.service';
import { VehicleModule } from '../vehicles/vehicle.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CatalogModule } from '../catalog/catalog.module';

@Module({
  imports: [
    ConfigModule,
    VehicleModule,
    NotificationsModule,
    CatalogModule,
  ],
  controllers: [TireController],
  providers: [TireService, TireProjectionService, S3Service, PrismaService],
  exports: [TireService, TireProjectionService],
})
export class TireModule {}