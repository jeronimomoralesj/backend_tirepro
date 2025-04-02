import { Module, forwardRef } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module'; 
import { PrismaService } from '../database/prisma.service';  
import { EmailModule } from '../email/email.module';

@Module({
  imports: [
    forwardRef(() => AuthModule),
    DatabaseModule,
    EmailModule,
  ],
  providers: [UsersService, PrismaService], 
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule {}
