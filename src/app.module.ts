import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { DatabaseModule } from './database/database.module';
import { CompaniesModule } from './companies/companies.module';
import { VehicleModule } from './vehicles/vehicle.module';
import { TireModule } from './tires/tire.module';
import { BlogModule } from './blogs/blogs.module';
import { ExtrasModule } from './extras/extras.module';
import { ComunidadModule } from './comunidad/comunidad.module';
import { CuponesModule } from './cupones/cupones.module';
import { IncomeModule } from './income/income.module';
import { EmailModule } from './email/email.module';
import { MarketDataModule } from './market-data/market-data.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    DatabaseModule,
    AuthModule,
    UsersModule,
    CompaniesModule, 
    VehicleModule,
    TireModule,
    BlogModule,
    ExtrasModule,
    ComunidadModule,
    CuponesModule,
    IncomeModule,
    EmailModule,
    MarketDataModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
