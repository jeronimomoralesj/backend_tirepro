import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { MailerModule } from '@nestjs-modules/mailer';

import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { UsersModule } from '../users/users.module';
import { DatabaseModule } from '../database/database.module';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  imports: [
    forwardRef(() => UsersModule),
    DatabaseModule,
    ConfigModule,

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
      useFactory: (cs: ConfigService) => ({
        transport: {
          host: cs.getOrThrow('SMTP_HOST'),
          port: cs.get<number>('SMTP_PORT', 587),
          secure: false,
          auth: {
            user: cs.getOrThrow('SMTP_USER'),
            pass: cs.getOrThrow('SMTP_PASS'),
          },
        },
        defaults: {
          from: cs.get('SMTP_FROM', 'noreply@tirepro.com.co'),
        },
      }),
    }),
  ],
  providers: [
    AuthService,
    PrismaService,
    JwtStrategy,
    JwtAuthGuard,
  ],
  controllers: [AuthController],
  exports: [AuthService, JwtAuthGuard, PassportModule, JwtModule],
})
export class AuthModule {}