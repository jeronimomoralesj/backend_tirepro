import { Module, forwardRef } from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { CatalogController } from './catalog.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { S3Service } from '../companies/s3.service';

@Module({
  imports: [PrismaModule, forwardRef(() => AuthModule)],
  controllers: [CatalogController],
  providers: [CatalogService, S3Service],
  exports: [CatalogService],
})
export class CatalogModule {}
