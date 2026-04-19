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
import { TireBenchmarkModule } from './tire-benchmark/tire-benchmark.module';
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
    //
    // In-memory store is what killed the EC2 box on 2026-04-17: every cached
    // tire response lived inside Node's heap and never got paged out, taking
    // us past the 4 GB RAM budget. Using Redis externalizes that pressure
    // and lets multiple backend instances share one cache.
    CacheModule.registerAsync({
      isGlobal: true,
      useFactory: async () => {
        const host = process.env.REDIS_HOST;
        const isProd = process.env.NODE_ENV === 'production';
        if (host && isProd) {
          const { redisStore } = await import('cache-manager-ioredis-yet');
          const store = await redisStore({
            host,
            port:     parseInt(process.env.REDIS_PORT ?? '6379', 10),
            password: process.env.REDIS_PASSWORD || undefined,
            // Drop whatever we can't store in Redis so the app never crashes
            // from a failed cache write; stale data is always preferable.
            ttl:      60 * 60 * 1000, // 1h default; individual set() calls can override
          });
          return { store: store as any, ttl: 60 * 60 * 1000 };
        }
        // Local dev: in-memory cache (no external dependency, starts instantly)
        return { ttl: 5 * 60 * 1000 };
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
    TireBenchmarkModule,
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