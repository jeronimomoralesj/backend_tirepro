import { Module } from '@nestjs/common';
import { TireService } from './tire.service';
import { TireController } from './tire.controller';
import { PrismaService } from '../database/prisma.service';
import { VehicleModule } from 'src/vehicles/vehicle.module';
import { NotificationsModule } from 'src/notifications/notifications.module';

@Module({
  imports: [VehicleModule, NotificationsModule],
  controllers: [TireController],
  providers: [TireService, PrismaService],
  exports: [TireService],
})
export class TireModule {}
