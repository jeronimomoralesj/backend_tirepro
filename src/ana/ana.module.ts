import { Module } from '@nestjs/common';
import { AnaController } from './ana.controller';
import { AnaService } from './ana.service';

@Module({
  controllers: [AnaController],
  providers: [AnaService],
  exports: [AnaService],
})
export class AnaModule {}
