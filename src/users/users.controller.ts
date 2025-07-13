// src/users/users.controller.ts
import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Patch,
  Param,
  Delete,
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { setTimeout } from 'timers/promises';
import { PrismaService } from 'src/prisma/prisma.service';
import { EmailService } from 'src/email/email.service';

@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService
  ) {}

  @Post('register')
  async createUser(@Body() createUserDto: CreateUserDto) {
    try {
      return await this.usersService.createUser(createUserDto);
    } catch (err) {
      throw new BadRequestException(err.message);
    }
  }

  @Get('verify')
async verifyEmail(@Query('token') token: string) {
  if (!token) throw new BadRequestException('Invalid verification link');

  const user = await this.prisma.user.findFirst({
    where: { verificationToken: token },
  });

  if (!user) throw new BadRequestException('Verification token is invalid or expired');

  await this.prisma.user.update({
    where: { id: user.id },
    data: { isVerified: true, verificationToken: null },
  });

  // 🕒 Delay sending the welcome email by 10 minutes (600_000 ms)
  setTimeout(600_000).then(async () => {
    try {
      if (user.preferredLanguage === 'en') {
        await this.emailService.sendWelcomeEmail(user.email, user.name);
      } else {
        await this.emailService.sendWelcomeEmailEs(user.email, user.name);
      }

      console.log(`✅ Welcome email (${user.preferredLanguage}) sent to ${user.email}`);
    } catch (err) {
      console.error(`❌ Failed to send welcome email to ${user.email}`, err);
    }
  });

  return {
    message:
      user.preferredLanguage === 'en'
        ? 'Email verified successfully. You can now log in.'
        : 'Correo verificado con éxito. Ya puedes iniciar sesión.',
  };
}

  @Get()
  async getUsers(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return await this.usersService.getUsersByCompany(companyId);
  }

  @Delete(':id')
  async deleteUser(@Param('id') userId: string) {
    try {
      return await this.usersService.deleteUser(userId);
    } catch (err) {
      throw new BadRequestException(err.message);
    }
  }

  @Patch('add-plate/:id')
  async addPlate(
    @Param('id') userId: string,
    @Body('plate') plate: string,
  ) {
    try {
      const result = await this.usersService.addPlate(userId, plate);
      return { plates: result.plates };
    } catch (err) {
      throw new BadRequestException(err.message);
    }
  }

  @Patch('remove-plate/:id')
  async removePlate(
    @Param('id') userId: string,
    @Body('plate') plate: string,
  ) {
    try {
      const result = await this.usersService.removePlate(userId, plate);
      return { plates: result.plates };
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      throw new BadRequestException(err.message);
    }
  }

  @Patch(':id/change-password')
  async changePassword(
    @Param('id') userId: string,
    @Body() body: { oldPassword: string; newPassword: string },
  ) {
    const { oldPassword, newPassword } = body;
    if (!oldPassword || !newPassword) {
      throw new BadRequestException(
        'Both oldPassword and newPassword are required',
      );
    }
    try {
      return await this.usersService.changePassword(
        userId,
        oldPassword,
        newPassword,
      );
    } catch (err) {
      if (
        err instanceof NotFoundException ||
        err instanceof UnauthorizedException
      ) {
        throw err;
      }
      throw new BadRequestException(err.message);
    }
  }

  @Get('all')
async getAllUsers() {
  return this.usersService.getAllUsers();
}

}
