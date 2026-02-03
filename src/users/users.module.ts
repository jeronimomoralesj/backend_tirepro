import { Module, forwardRef } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module'; 
import { PrismaService } from '../database/prisma.service';  
import { EmailModule } from '../email/email.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import { EmailService } from '../email/email.service';

@Module({
  imports: [
    forwardRef(() => AuthModule),
    DatabaseModule,
    EmailModule,
    PrismaModule,
  ],
  providers: [UsersService, PrismaService, EmailService], 
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule {}
