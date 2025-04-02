import { Module } from '@nestjs/common';
import { CompaniesService } from './companies.service';
import { CompaniesController } from './companies.controller';
import { DatabaseModule } from '../database/database.module';  

@Module({
  imports: [DatabaseModule],  
  controllers: [CompaniesController],
  providers: [CompaniesService],  
  exports: [CompaniesService],
})
export class CompaniesModule {}
