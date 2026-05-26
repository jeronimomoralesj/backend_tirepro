import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AnaController } from './ana.controller';
import { AnaService } from './ana.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [AnaController],
  providers: [AnaService],
  exports: [AnaService],
})
export class AnaModule {}
