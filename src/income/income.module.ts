// income.module.ts
import { Module } from '@nestjs/common';
import { IncomeController } from './income.controller';
import { IncomeService } from './income.service';
import { DatabaseModule } from '../database/database.module';
import { PrismaService } from '../database/prisma.service';

@Module({
  imports: [DatabaseModule],
  controllers: [IncomeController],
  providers: [IncomeService, PrismaService],
  exports: [IncomeService],
})
export class IncomeModule {}