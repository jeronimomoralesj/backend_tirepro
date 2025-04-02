import { 
    Controller, Post, Patch, Get, Param, Body,Query, BadRequestException, UseGuards, Delete, Request 
  } from '@nestjs/common';
  import { UsersService } from './users.service';
  import { AuthService } from '../auth/auth.service';
  import { CreateUserDto } from './dto/create-user.dto';
  import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
  import { LoginDto } from './dto/login.dto';
  
  @Controller('users')
  export class UsersController {
    constructor(
      private readonly usersService: UsersService,
      private readonly authService: AuthService,
    ) {}
  
    @Post('register')
    async register(@Body() createUserDto: CreateUserDto) {
      return this.usersService.createUser(createUserDto);
    }

    @Get()
    async getUsersByCompany(@Query('companyId') companyId: string) {
      return this.usersService.getUsersByCompany(companyId);
    }

    @Patch('add-plate/:userId')
  async addPlate(
    @Param('userId') userId: string,
    @Body('plate') plate: string
  ) {
    if (!plate) {
      throw new BadRequestException('Plate is required');
    }
    return this.usersService.addPlate(userId, plate);
  }

  @Delete(':id')
  async deleteUser(@Param('id') id: string) {
    try {
      const deletedUser = await this.usersService.deleteUser(id);
      return { message: 'User deleted successfully', user: deletedUser };
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }
  
  }
  