import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AnaController } from './ana.controller';
import { AnaService } from './ana.service';

@Module({
  imports: [PrismaModule],
  controllers: [AnaController],
  providers: [AnaService],
  exports: [AnaService],
})
export class AnaModule {}
