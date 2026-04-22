import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EmailModule } from '../email/email.module';
import { TireModule } from '../tires/tire.module';
import { InventoryBucketsModule } from '../tires/inventory-bucket.module';
import { PurchaseOrdersService } from './purchase-orders.service';
import { PurchaseOrdersController } from './purchase-orders.controller';

@Module({
  // TireModule + InventoryBucketsModule give us updateVida (for approve /
  // reject flows) and the Reencauche bucket lookup, respectively.
  imports: [PrismaModule, EmailModule, TireModule, InventoryBucketsModule],
  controllers: [PurchaseOrdersController],
  providers: [PurchaseOrdersService],
  exports: [PurchaseOrdersService],
})
export class PurchaseOrdersModule {}
