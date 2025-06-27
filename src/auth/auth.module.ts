// src/auth/auth.module.ts
import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule }                 from '@nestjs/jwt';
import { PassportModule }            from '@nestjs/passport';
import { MailerModule }              from '@nestjs-modules/mailer';

import { AuthService }               from './auth.service';
import { AuthController }            from './auth.controller';
import { JwtStrategy }               from './strategies/jwt.strategy';
import { UsersModule }               from '../users/users.module';
import { DatabaseModule }            from '../database/database.module';
import { BlogService }               from '../blogs/blogs.service';
import { PrismaService }             from '../prisma/prisma.service';

@Module({
  imports: [
    forwardRef(() => UsersModule),
    DatabaseModule,
    ConfigModule,
    // Passport registration for "jwt" strategy
    PassportModule.register({ defaultStrategy: 'jwt' }),
    // Async JWT config so we pick up JWT_SECRET from ConfigService
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (cs: ConfigService) => ({
        secret: cs.get<string>('JWT_SECRET', 'supersecret'),
        signOptions: { expiresIn: '1h' },
      }),
    }),
    // Mailer for blog-password emails
    MailerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (cs: ConfigService) => ({
        transport: {
          host: cs.get('SMTP_HOST'),
          port: cs.get<number>('SMTP_PORT'),
          secure: false,
          auth: {
            user: cs.get('SMTP_USER'),
            pass: cs.get('SMTP_PASS'),
          },
        },
        defaults: { from: cs.get('SMTP_FROM') },
      }),
    }),
  ],
  providers: [
    AuthService,
    BlogService,
    PrismaService,
    JwtStrategy,    // ← register your strategy here
  ],
  controllers: [AuthController],
  exports: [AuthService, PassportModule],
})
export class AuthModule {}
