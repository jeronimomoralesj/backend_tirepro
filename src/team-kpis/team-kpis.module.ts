import { Module } from '@nestjs/common';
import { TeamKpisService } from './team-kpis.service';
import { TeamKpisController } from './team-kpis.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports:     [PrismaModule, AuthModule],
  controllers: [TeamKpisController],
  providers:   [TeamKpisService],
  exports:     [TeamKpisService],
})
export class TeamKpisModule {}
