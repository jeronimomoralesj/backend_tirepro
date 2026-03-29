import { Module } from '@nestjs/common';
import { MarketplaceController } from './marketplace.controller';
import { MarketplaceService } from './marketplace.service';
import { PrismaModule } from '../prisma/prisma.module';
import { S3Service } from '../companies/s3.service';
import { ConfigModule } from '@nestjs/config';
import { EmailService } from '../email/email.service';

@Module({
  imports: [PrismaModule, ConfigModule],
  controllers: [MarketplaceController],
  providers: [MarketplaceService, S3Service, EmailService],
  exports: [MarketplaceService],
})
export class MarketplaceModule {}
