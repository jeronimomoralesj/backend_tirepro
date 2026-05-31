import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AiUsageService } from './ai-usage.service';
import { AiUsageGuard } from './ai-usage.guard';

// Global so any controller can apply @UseGuards(AiUsageGuard) / inject
// AiUsageService without re-importing.
@Global()
@Module({
  imports: [PrismaModule],
  providers: [AiUsageService, AiUsageGuard],
  exports: [AiUsageService, AiUsageGuard],
})
export class AiUsageModule {}
