import { Module, forwardRef } from '@nestjs/common';
import { MarketplaceController } from './marketplace.controller';
import { MarketplaceService } from './marketplace.service';
import { PrismaModule } from '../prisma/prisma.module';
import { S3Service } from '../companies/s3.service';
import { ConfigModule } from '@nestjs/config';
import { EmailService } from '../email/email.service';
import { PlateLookupService } from './plate-lookup.service';
import { WompiService } from './wompi.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, ConfigModule, forwardRef(() => AuthModule)],
  controllers: [MarketplaceController],
  providers: [MarketplaceService, S3Service, EmailService, PlateLookupService, WompiService],
  exports: [MarketplaceService],
})
export class MarketplaceModule {}
