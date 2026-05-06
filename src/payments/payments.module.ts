import { Module, forwardRef } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { BoldService } from './bold.service';
import { PrismaModule } from '../prisma/prisma.module';
import { EmailModule } from '../email/email.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  // AuthModule re-exports JwtModule so we can inject JwtService into the
  // payments controller. Used to optionally decode the Bearer token on
  // /payments/{wompi,bold}/checkout (public endpoints that attach the
  // order to a logged-in user when one is present).
  imports:     [PrismaModule, EmailModule, forwardRef(() => AuthModule)],
  controllers: [PaymentsController],
  providers:   [PaymentsService, BoldService],
  exports:     [PaymentsService],
})
export class PaymentsModule {}
