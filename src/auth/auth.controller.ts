// auth.controller.ts
import { Controller, Post, Body } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from '../users/dto/login.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  async register(@Body() body: { email: string; name: string; password: string }) {
    return this.authService.register(body.email, body.name, body.password);
  }

  @Post('login')
  async login(@Body() loginDto: LoginDto) {
    console.log('Login DTO:', loginDto); // Verify the structure here
    return this.authService.login(loginDto.email, loginDto.password);
  }
  
}  