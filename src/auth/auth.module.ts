import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { MailerModule } from '@nestjs-modules/mailer';

import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CompanyScopeGuard } from './guards/company-scope.guard';
import { AdminPasswordGuard } from './guards/admin-password.guard';
import { UsersModule } from '../users/users.module';
import { DatabaseModule } from '../database/database.module';
import { PrismaService } from '../prisma/prisma.service';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [
    forwardRef(() => UsersModule),
    DatabaseModule,
    ConfigModule,
    EmailModule,

    PassportModule.register({ defaultStrategy: 'jwt' }),

    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (cs: ConfigService) => ({
        secret: cs.getOrThrow<string>('JWT_SECRET'), // throws at startup if missing
        signOptions: {
          expiresIn: cs.get<string>('JWT_EXPIRES_IN', '7d'),
        },
      }),
    }),

    MailerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (cs: ConfigService) => {
        // AWS EC2 blocks outbound port 587 on many account profiles, which
        // surfaces as "Greeting never received" after a 10s timeout when
        // nodemailer waits for Gmail's 220 banner. Port 465 (implicit TLS)
        // goes through cleanly from EC2 so we default to that — or use
        // nodemailer's built-in `service: 'gmail'` preset which negotiates
        // the right combination automatically. The working EmailService
        // uses the same approach and hasn't had issues.
        const host  = cs.get<string>('SMTP_HOST') || '';
        const port  = cs.get<number>('SMTP_PORT', 465);
        const user  = cs.getOrThrow<string>('SMTP_USER');
        const pass  = cs.getOrThrow<string>('SMTP_PASS');
        const isGmail = /smtp\.gmail\.com/i.test(host);

        // Gmail with no explicit overrides → use the preset (most reliable
        // on EC2). Anything else → explicit host/port/secure.
        const transport: Record<string, unknown> = isGmail
          ? {
              service: 'gmail',
              auth: { user, pass },
              connectionTimeout: 10_000,
              greetingTimeout:   10_000,
              socketTimeout:     15_000,
            }
          : {
              host,
              port,
              secure:     port === 465,
              requireTLS: port === 587,
              auth: { user, pass },
              connectionTimeout: 10_000,
              greetingTimeout:   10_000,
              socketTimeout:     15_000,
            };

        return {
          transport,
          defaults: {
            from: cs.get('SMTP_FROM', 'noreply@tirepro.com.co'),
          },
        };
      },
    }),
  ],
  providers: [
    AuthService,
    PrismaService,
    JwtStrategy,
    JwtAuthGuard,
    CompanyScopeGuard,
    AdminPasswordGuard,
  ],
  controllers: [AuthController],
  exports: [AuthService, JwtAuthGuard, CompanyScopeGuard, AdminPasswordGuard, PassportModule, JwtModule],
})
export class AuthModule {}