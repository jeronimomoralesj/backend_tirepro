import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CacheModule } from '@nestjs/cache-manager';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD } from '@nestjs/core';
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
import { InventoryBucketsModule } from './tires/inventory-bucket.module';
import { PurchaseOrdersModule } from './purchase-orders/purchase-orders.module';
import { CatalogModule } from './catalog/catalog.module';
import { MarketplaceModule } from './marketplace/marketplace.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { CompanyScopeGuard } from './auth/guards/company-scope.guard';
import { PrismaService } from './prisma/prisma.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    ScheduleModule.forRoot(),

    // ── Global cache — Redis in production, in-memory locally ──────────────
    // isGlobal: true means every module gets this same cache instance.
    // No feature module should import CacheModule.register() separately.
    CacheModule.registerAsync({
      isGlobal: true,
      useFactory: async () => {
        const redisHost = process.env.REDIS_HOST;
        // Only use Redis if explicitly in production
        if (redisHost && process.env.NODE_ENV === 'production') {
          const { redisStore } = await import('cache-manager-ioredis-yet');
          return {
            store: redisStore,
            host: redisHost,
            port: parseInt(process.env.REDIS_PORT ?? '6379'),
            ttl: 60 * 60,
          };
        }
        // Local dev: in-memory cache (no external dependency, starts instantly)
        return { ttl: 300 };
      },
    }),

    // ── Rate limiting ────────────────────────────────────────────────────────
    ThrottlerModule.forRoot([
      { name: 'short',  ttl: 1000,    limit: 10   },  // 10 req/sec
      { name: 'medium', ttl: 60000,   limit: 100  },  // 100 req/min
      { name: 'long',   ttl: 3600000, limit: 1000 },  // 1000 req/hr
    ]),

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
    InventoryBucketsModule,
    PurchaseOrdersModule,
    MarketplaceModule,
    CatalogModule,
    WhatsappModule,
  ],
  controllers: [AppController],
  providers:   [
    AppService,
    PrismaService,
    CompanyScopeGuard,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}