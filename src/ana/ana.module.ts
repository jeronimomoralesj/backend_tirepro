import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AutomationModule } from '../automation/automation.module';
import { GoogleCalendarModule } from '../integrations/google-calendar/google-calendar.module';
import { AnaController } from './ana.controller';
import { AnaService } from './ana.service';

@Module({
  imports: [PrismaModule, AuthModule, AutomationModule, GoogleCalendarModule],
  controllers: [AnaController],
  providers: [AnaService],
  exports: [AnaService],
})
export class AnaModule {}
