import { Module, forwardRef } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PrismaModule } from '../prisma/prisma.module';
import { EmailModule } from '../email/email.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  // AuthModule re-exports JwtModule so we can inject JwtService into the
  // payments controller. Used to optionally decode the Bearer token on
  // /payments/wompi/checkout (a public endpoint that needs to attach
  // the order to a logged-in user when one is present).
  imports:     [PrismaModule, EmailModule, forwardRef(() => AuthModule)],
  controllers: [PaymentsController],
  providers:   [PaymentsService],
  exports:     [PaymentsService],
})
export class PaymentsModule {}
