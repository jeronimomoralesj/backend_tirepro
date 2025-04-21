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

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post('register')
  async createUser(@Body() createUserDto: CreateUserDto) {
    try {
      return await this.usersService.createUser(createUserDto);
    } catch (err) {
      throw new BadRequestException(err.message);
    }
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

}
