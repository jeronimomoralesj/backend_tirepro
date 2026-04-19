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
        const port = cs.get<number>('SMTP_PORT', 587);
        return {
          transport: {
            host: cs.getOrThrow('SMTP_HOST'),
            port,
            // Port 465 uses implicit TLS; 587 uses STARTTLS — Gmail closes
            // the socket silently when `requireTLS` isn't set on 587, which
            // surfaces as "Unexpected socket close" in the log.
            secure: port === 465,
            requireTLS: port === 587,
            auth: {
              user: cs.getOrThrow('SMTP_USER'),
              pass: cs.getOrThrow('SMTP_PASS'),
            },
            // Bounded timeouts so a failing mail doesn't hang the request
            // for 30+ seconds while the admin waits for the password.
            connectionTimeout: 10_000,
            greetingTimeout:   10_000,
            socketTimeout:     15_000,
          },
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