import { Module }       from '@nestjs/common';
import { CacheModule }  from '@nestjs/cache-manager';   // ← ADD
import { PrismaModule } from '../prisma/prisma.module';
import { InventoryBucketsService } from './inventory-bucket.service';
import { InventoryBucketsController } from './inventory-bucket.controller';

@Module({
  imports:     [PrismaModule, CacheModule.register()],
  controllers: [InventoryBucketsController],
  providers:   [InventoryBucketsService],
  exports:     [InventoryBucketsService],
})
export class InventoryBucketsModule {}