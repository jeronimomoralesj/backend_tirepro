import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from '../users/dto/login.dto';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService
  ) {}

  @Post('register')
  async register(@Body() body: { email: string; name: string; password: string }) {
    return this.authService.register(body.email, body.name, body.password);
  }

  @Post('login')
  async login(@Body() loginDto: LoginDto) {
    console.log('Login DTO:', loginDto);
    return this.authService.login(loginDto.email, loginDto.password);
  }

  @Post('generate-password')
  @HttpCode(HttpStatus.OK)
  async generatePassword() {
    try {
      await this.authService.generateBlogPassword();
      return { 
        success: true, 
        message: 'Contraseña generada y enviada exitosamente a info@tirepro.com.co' 
      };
    } catch (error) {
      return { 
        success: false, 
        message: 'Error al generar la contraseña' 
      };
    }
  }

  @Post('verify-password')
  @HttpCode(HttpStatus.OK)
  async verifyPassword(@Body() body: { password: string }) {
    try {
      const isValid = await this.authService.verifyBlogPassword(body.password);
      
      if (!isValid) {
        return { 
          success: false, 
          message: 'Contraseña inválida o expirada' 
        };
      }
      
      return { 
        success: true, 
        message: 'Contraseña verificada exitosamente' 
      };
    } catch (error) {
      return { 
        success: false, 
        message: 'Error al verificar la contraseña' 
      };
    }
  }
}