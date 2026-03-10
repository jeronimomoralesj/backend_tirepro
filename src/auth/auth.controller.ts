import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

interface AuthUser {
  id:        string;
  email:     string;
  name:      string;
  role:      UserRole;
  companyId: string;
  company: {
    id:           string;
    name:         string;
    plan:         string;
    profileImage: string;
  } | null;
}

@Controller('auth')
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body() dto: RegisterDto,
  ): Promise<{ message: string; userId: string }> {
    return this.authService.register(dto.email, dto.name, dto.password);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
  ): Promise<{ access_token: string; user: AuthUser }> {
    return this.authService.login(dto.email, dto.password);
  }

  // ── Blog password ─────────────────────────────────────────────────────────

  @Post('generate-password')
  @HttpCode(HttpStatus.OK)
  async generatePassword(): Promise<{ success: boolean; message: string }> {
    await this.authService.generateBlogPassword();
    return { success: true, message: 'Contraseña generada y enviada exitosamente.' };
  }

  @Post('verify-password')
  @HttpCode(HttpStatus.OK)
  async verifyPassword(
    @Body() body: { password: string },
  ): Promise<{ success: boolean; message: string }> {
    const isValid = await this.authService.verifyBlogPassword(body.password);
    return isValid
      ? { success: true,  message: 'Contraseña verificada exitosamente.' }
      : { success: false, message: 'Contraseña inválida o expirada.' };
  }

  // ── Distributor password ──────────────────────────────────────────────────

  @Post('generate-distributor-password')
  @HttpCode(HttpStatus.OK)
  async generateDistributorPassword(): Promise<{ success: boolean; message: string }> {
    await this.authService.generateDistributorPassword();
    return { success: true, message: 'Contraseña de distribuidor generada y enviada.' };
  }

  @Post('verify-distributor-password')
  @HttpCode(HttpStatus.OK)
  async verifyDistributorPassword(
    @Body() body: { password: string },
  ): Promise<{ success: boolean; message: string }> {
    const isValid = await this.authService.verifyDistributorPassword(body.password);
    return isValid
      ? { success: true,  message: 'Acceso de distribuidor verificado.' }
      : { success: false, message: 'Contraseña inválida o expirada.' };
  }
}