import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
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
    // Config must be first — all other modules may depend on env vars
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),

    // Database — single shared PrismaService across the whole app
    PrismaModule,

    // Feature modules
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