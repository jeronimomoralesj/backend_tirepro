import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { DatabaseModule } from './database/database.module';
import { CompaniesModule } from './companies/companies.module'; // Import here
import { VehicleModule } from './vehicles/vehicle.module';
import { TireModule } from './tires/tire.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    AuthModule,
    UsersModule,
    CompaniesModule, 
    VehicleModule,
    TireModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
