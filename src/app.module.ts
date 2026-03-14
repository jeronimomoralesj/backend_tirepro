import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CacheModule } from '@nestjs/cache-manager';
import { redisStore } from 'cache-manager-ioredis-yet';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { CompaniesModule } from './companies/companies.module';
import { VehicleModule } from './vehicles/vehicle.module';
import { TireModule } from './tires/tire.module';
import { BlogModule } from './blogs/blogs.module';
import { ExtrasModule } from './extras/extras.module';
import { ComunidadModule } from './comunidad/comunidad.module';
import { CuponesModule } from './cupones/cupones.module';
import { IncomeModule } from './income/income.module';
import { EmailModule } from './email/email.module';
import { NotificationsModule } from './notifications/notifications.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),

    // ── Global Redis cache — shared across ALL feature modules ────────────────
    // Feature modules use CacheModule.register() locally just to satisfy DI,
    // but this global registration is what actually connects to Redis.
    CacheModule.registerAsync({
      isGlobal: true,
      useFactory: async () => ({
        store: redisStore,
        host:  process.env.REDIS_HOST ?? '127.0.0.1',
        port:  parseInt(process.env.REDIS_PORT ?? '6379'),
        ttl:   2 * 60 * 60 * 60 * 1000,
      }),
    }),

    PrismaModule,
    AuthModule,
    UsersModule,
    CompaniesModule,
    VehicleModule,
    TireModule,
    NotificationsModule,
    BlogModule,
    ExtrasModule,
    ComunidadModule,
    CuponesModule,
    IncomeModule,
    EmailModule,
  ],
  controllers: [AppController],
  providers:   [AppService],
})
export class AppModule {}