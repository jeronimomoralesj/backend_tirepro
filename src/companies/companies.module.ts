import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CacheModule } from '@nestjs/cache-manager';
import { CompaniesService } from './companies.service';
import { CompaniesController } from './companies.controller';
import { S3Service } from './s3.service';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [DatabaseModule, ConfigModule, CacheModule.register()],
  controllers: [CompaniesController],
  providers: [CompaniesService, S3Service],
  exports: [CompaniesService, S3Service],
})
export class CompaniesModule {}