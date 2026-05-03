import { Module, forwardRef } from '@nestjs/common';
import { MarketplaceController } from './marketplace.controller';
import { MarketplaceService } from './marketplace.service';
import { MarketplaceStatsService } from './marketplace-stats.service';
import { RetailScraperService } from './retail-scraper.service';
import { RetailSourceService } from './retail-source.service';
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
  providers: [
    MarketplaceService, MarketplaceStatsService,
    RetailScraperService, RetailSourceService,
    S3Service, EmailService, PlateLookupService, WompiService,
  ],
  exports: [MarketplaceService, MarketplaceStatsService, RetailSourceService],
})
export class MarketplaceModule {}
