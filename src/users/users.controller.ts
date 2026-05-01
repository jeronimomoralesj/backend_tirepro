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
  HttpCode,
  HttpStatus,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { PrismaService } from '../database/prisma.service';
import { EmailService } from '../email/email.service';
import { setTimeout as setTimeoutPromise } from 'timers/promises';

@Controller('users')
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
  ) {}

  // ===========================================================================
  // Static routes first (must be before :id param routes)
  // ===========================================================================

  @Get('all')
  @UseGuards(JwtAuthGuard)
  getAllUsers() {
    return this.usersService.getAllUsers();
  }

  @Get('verify')
  async verifyEmail(@Query('token') token: string) {
    if (!token) throw new BadRequestException('Invalid verification link');

    const user = await this.prisma.user.findFirst({
      where:  { verificationToken: token },
      select: {
        id: true, email: true, name: true, preferredLanguage: true,
        // Pull the expiry so we can reject stale tokens — the
        // auth-cleanup cron may not have purged the row yet (runs
        // hourly), so the user could still click an old link.
        verificationTokenExpiresAt: true,
        companyId: true,
      },
    });
    if (!user) throw new BadRequestException('Verification token is invalid or expired');
    if (
      user.verificationTokenExpiresAt &&
      user.verificationTokenExpiresAt.getTime() < Date.now()
    ) {
      throw new BadRequestException('Verification link expired. Please register again.');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data:  {
        isVerified:                 true,
        verificationToken:          null,
        verificationTokenExpiresAt: null,
        emailVerifiedAt:            new Date(),
      },
    });

    // The user verifying their email also implicitly verifies their
    // company (if any). This covers the "self-served signup that created
    // a company" flow without forcing a TirePro admin to manually
    // approve every brand-new tenant.
    if (user.companyId) {
      await this.prisma.company.update({
        where: { id: user.companyId },
        data:  { isVerified: true, verifiedAt: new Date() },
      }).catch(() => { /* company may have already been removed */ });
    }

    // Welcome email is for FLEET users (the main TirePro experience —
    // dashboards, inspections, CPK tracking). It's the wrong message
    // for two cohorts so we suppress it for them:
    //   1. Marketplace-only users — no companyId, just signed up to
    //      buy tires. The order-confirmation flow already greets them.
    //   2. Distribuidor-plan companies — they have a different
    //      onboarding (catalog setup, storefront, pedidos pipeline).
    setTimeoutPromise(600).then(async () => {
      try {
        let plan: string | null = null;
        if (user.companyId) {
          const company = await this.prisma.company.findUnique({
            where: { id: user.companyId },
            select: { plan: true },
          });
          plan = company?.plan ?? null;
        }
        // No companyId = marketplace-only buyer. Distribuidor plan is
        // gated separately. Anything else (pro / plus / pre-existing
        // plans) gets the welcome.
        const shouldSendWelcome = !!user.companyId && plan !== 'distribuidor' && plan !== 'marketplace';
        if (!shouldSendWelcome) return;
        if (user.preferredLanguage === 'en') {
          await this.emailService.sendWelcomeEmail(user.email, user.name);
        } else {
          await this.emailService.sendWelcomeEmailEs(user.email, user.name);
        }
      } catch (err: any) {
      }
    });

    return {
      message: user.preferredLanguage === 'en'
        ? 'Email verified successfully. You can now log in.'
        : 'Correo verificado con éxito. Ya puedes iniciar sesión.',
    };
  }

  // ===========================================================================
  // Create
  // ===========================================================================

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  createUser(@Body() dto: CreateUserDto) {
    return this.usersService.createUser(dto);
  }

  // ===========================================================================
  // Read
  // ===========================================================================

  @Get()
  @UseGuards(JwtAuthGuard)
  getUsers(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.usersService.getUsersByCompany(companyId);
  }

  /**
   * Per-user inspection stats for a company in a date range.
   * Used by the distribuidor's Gestión → Mi Equipo tab to surface who's
   * actually doing inspections and how recently.
   */
  @Get('inspection-stats')
  @UseGuards(JwtAuthGuard)
  getUserInspectionStats(
    @Query('companyId') companyId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('days') days?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    const daysNum = days ? parseInt(days, 10) : undefined;
    return this.usersService.getUserInspectionStats(
      companyId,
      from,
      to,
      Number.isFinite(daysNum) ? daysNum : undefined,
    );
  }

  @Get(':id/vehicles')
  @UseGuards(JwtAuthGuard)
  getAccessibleVehicles(@Param('id') userId: string) {
    return this.usersService.getAccessibleVehicles(userId);
  }

  // ===========================================================================
  // Update
  // ===========================================================================

  @Patch(':id/notification-prefs')
  @UseGuards(JwtAuthGuard)
  updateNotificationPrefs(
    @Param('id') userId: string,
    @Body() body: { notifChannel?: string | null; notifContact?: string | null; saturnVUnlocked?: boolean },
  ) {
    return this.usersService.updateNotificationPrefs(userId, body);
  }

  @Get(':id/notification-prefs')
  @UseGuards(JwtAuthGuard)
  getNotificationPrefs(@Param('id') userId: string) {
    return this.usersService.getNotificationPrefs(userId);
  }

  @Patch(':id/change-password')
  @UseGuards(JwtAuthGuard)
  async changePassword(
    @Param('id') userId: string,
    @Body() body: { oldPassword: string; newPassword: string },
  ) {
    const { oldPassword, newPassword } = body;
    if (!oldPassword || !newPassword) {
      throw new BadRequestException('Both oldPassword and newPassword are required');
    }
    return this.usersService.changePassword(userId, oldPassword, newPassword);
  }

  @Patch(':id/vehicles/grant')
  @UseGuards(JwtAuthGuard)
  grantVehicleAccess(
    @Param('id') userId: string,
    @Body('vehicleId') vehicleId: string,
  ) {
    if (!vehicleId) throw new BadRequestException('vehicleId is required');
    return this.usersService.grantVehicleAccess(userId, vehicleId);
  }

  @Patch(':id/vehicles/revoke')
  @UseGuards(JwtAuthGuard)
  revokeVehicleAccess(
    @Param('id') userId: string,
    @Body('vehicleId') vehicleId: string,
  ) {
    if (!vehicleId) throw new BadRequestException('vehicleId is required');
    return this.usersService.revokeVehicleAccess(userId, vehicleId);
  }

  @Patch('add-plate/:id')
  @UseGuards(JwtAuthGuard)
  async addPlate(
    @Param('id') userId: string,
    @Body('plate') plate: string,
  ) {
    if (!plate) throw new BadRequestException('plate is required');
    return this.usersService.addPlate(userId, plate);
  }

  @Patch('remove-plate/:id')
  @UseGuards(JwtAuthGuard)
  async removePlate(
    @Param('id') userId: string,
    @Body('plate') plate: string,
  ) {
    if (!plate) throw new BadRequestException('plate is required');
    return this.usersService.removePlate(userId, plate);
  }

  // Generic update endpoint — used by /dashboard/ajustes (admin) to change
  // a teammate's role inline. Service-side validation rejects unknown
  // role strings against the Prisma UserRole enum, so the surface area
  // is the typed `Partial<{ name, role, puntos, preferredLanguage }>`
  // and nothing else can leak through.
  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  async updateUser(
    @Param('id') userId: string,
    @Body()
    body: Partial<{
      name: string;
      role: string;
      puntos: number;
      preferredLanguage: string;
    }>,
  ) {
    return this.usersService.updateUser(userId, body);
  }

  // ===========================================================================
  // Delete
  // ===========================================================================

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  deleteUser(@Param('id') userId: string) {
    return this.usersService.deleteUser(userId);
  }
}