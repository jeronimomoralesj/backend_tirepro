import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { MailerService } from '@nestjs-modules/mailer';
import { EmailService } from '../email/email.service';
import { UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TokenPayload {
  sub: string;
  email: string;
  companyId: string;
  role: UserRole;
}

interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  companyId: string;
  company: {
    id: string;
    name: string;
    plan: string;
    profileImage: string;
  } | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BCRYPT_ROUNDS = 12;
const BLOG_PASSWORD_TTL_HOURS = 24;

// Dummy hash for constant-time comparison when no record exists.
const DUMMY_HASH =
  '$2a$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly mailerService: MailerService,
    private readonly configService: ConfigService,
    private readonly emailService: EmailService,
  ) {}

  // -------------------------------------------------------------------------
  // JWT helpers
  // -------------------------------------------------------------------------

  private buildPayload(user: {
    id: string;
    email: string;
    companyId: string;
    role: UserRole;
  }): TokenPayload {
    return {
      sub: user.id,
      email: user.email,
      companyId: user.companyId,
      role: user.role,
    };
  }

  generateJwt(user: {
    id: string;
    email: string;
    companyId: string;
    role: UserRole;
  }): string {
    return this.jwtService.sign(this.buildPayload(user));
  }

  // -------------------------------------------------------------------------
  // register
  // -------------------------------------------------------------------------

  async register(
    email: string,
    name: string,
    password: string,
  ): Promise<{ message: string; userId: string }> {
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new BadRequestException('User already exists');

    const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const user = await this.prisma.user.create({
      data: {
        email,
        name,
        password: hashed,
        companyId: null,
        role: UserRole.admin,
        userPlan: 'free',
        puntos: 0,
        isVerified: true, // standalone users skip email verification
      },
    });

    return { message: 'User registered successfully', userId: user.id };
  }

  // -------------------------------------------------------------------------
  // login
  // -------------------------------------------------------------------------

  async login(
    email: string,
    password: string,
  ): Promise<{ access_token: string; user: AuthUser }> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        name: true,
        password: true,
        role: true,
        companyId: true,
        isVerified: true,
        userPlan: true,
        company: {
          select: {
            id: true,
            name: true,
            plan: true,
            profileImage: true,
          },
        },
      },
    });

    const hashToCompare = user?.password ?? DUMMY_HASH;
    const passwordValid = await bcrypt.compare(password, hashToCompare);

    if (!user || !passwordValid) {
      throw new BadRequestException('Invalid credentials');
    }

    if (!user.isVerified) {
      throw new BadRequestException(
        'Please verify your email before logging in.',
      );
    }

    const access_token = this.generateJwt({
      id: user.id,
      email: user.email,
      companyId: user.companyId ?? '',
      role: user.role,
    });

    return {
      access_token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        companyId: user.companyId ?? '',
        company: user.company ?? null,
        userPlan: (user as any).userPlan ?? 'free',
      },
    };
  }

  // -------------------------------------------------------------------------
  // validateUser  (used by Passport local strategy if ever added)
  // -------------------------------------------------------------------------

  async validateUser(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    const token = this.generateJwt(user);
    const { password: _pw, ...safeUser } = user;
    return { token, user: safeUser };
  }

  // -------------------------------------------------------------------------
  // Distributor one-time password
  // -------------------------------------------------------------------------

  async generateDistributorPassword(): Promise<void> {
    const plainPassword = crypto.randomBytes(8).toString('hex');
    const hashed = await bcrypt.hash(plainPassword, BCRYPT_ROUNDS);

    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + BLOG_PASSWORD_TTL_HOURS);

    await this.prisma.blogPassword.upsert({
      where: { id: 1 },
      update: { password: hashed, expiresAt, isUsed: false },
      create: { password: hashed, expiresAt, isUsed: false },
    });

    const adminEmail = this.configService.get<string>(
      'ADMIN_EMAIL',
      'info@tirepro.com.co',
    );

    try {
      await this.mailerService.sendMail({
        to: adminEmail,
        subject: 'Nueva Contraseña de Distribuidor — TirePro',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
            <h2 style="color:#348CCB;">Nueva Contraseña de Distribuidor</h2>
            <p>Se ha generado una nueva contraseña para el registro de distribuidores:</p>
            <div style="background:#f5f5f5;padding:15px;border-radius:5px;margin:20px 0;">
              <strong style="font-size:18px;color:#333;">${plainPassword}</strong>
            </div>
            <p><strong>⚠️ Importante:</strong></p>
            <ul>
              <li>Expira en ${BLOG_PASSWORD_TTL_HOURS} horas</li>
              <li>Solo puede ser usada una vez</li>
            </ul>
            <hr style="margin:30px 0;border:none;border-top:1px solid #ddd;">
            <p style="color:#666;font-size:12px;">
              Correo automático del sistema de administración de TirePro.
            </p>
          </div>
        `,
      });
    } catch (err) {
      this.logger.error('Failed to send distributor password email: ' + err.message);
      throw new InternalServerErrorException(
        'Error al enviar el correo con la contraseña',
      );
    }
  }

  async verifyDistributorPassword(password: string): Promise<boolean> {
    try {
      const record = await this.prisma.blogPassword.findFirst({
        where: { isUsed: false, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      });

      const hashToCompare = record?.password ?? DUMMY_HASH;
      const isValid = await bcrypt.compare(password, hashToCompare);

      if (isValid && record) {
        await this.prisma.blogPassword.update({
          where: { id: record.id },
          data: { isUsed: true },
        });
        return true;
      }

      return false;
    } catch (err) {
      this.logger.error('verifyDistributorPassword error: ' + err.message);
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Blog one-time password (kept separate from distributor password)
  // -------------------------------------------------------------------------

  async generateBlogPassword(): Promise<void> {
    const plainPassword = crypto.randomBytes(8).toString('hex');
    const hashed = await bcrypt.hash(plainPassword, BCRYPT_ROUNDS);

    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + BLOG_PASSWORD_TTL_HOURS);

    await this.prisma.blogPassword.upsert({
      where: { id: 1 },
      update: { password: hashed, expiresAt, isUsed: false },
      create: { password: hashed, expiresAt, isUsed: false },
    });

    const adminEmail = this.configService.get<string>(
      'ADMIN_EMAIL',
      'info@tirepro.com.co',
    );

    try {
      await this.mailerService.sendMail({
        to: adminEmail,
        subject: 'Nueva Contraseña de Admin — Blog TirePro',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
            <h2 style="color:#348CCB;">Nueva Contraseña de Administrador</h2>
            <p>Se ha generado una nueva contraseña para el panel de administración del blog:</p>
            <div style="background:#f5f5f5;padding:15px;border-radius:5px;margin:20px 0;">
              <strong style="font-size:18px;color:#333;">${plainPassword}</strong>
            </div>
            <p><strong>⚠️ Importante:</strong></p>
            <ul>
              <li>Expira en ${BLOG_PASSWORD_TTL_HOURS} horas</li>
              <li>Solo puede ser usada una vez</li>
            </ul>
            <hr style="margin:30px 0;border:none;border-top:1px solid #ddd;">
            <p style="color:#666;font-size:12px;">
              Correo automático del sistema de administración de TirePro.
            </p>
          </div>
        `,
      });
    } catch (err) {
      this.logger.error('Failed to send blog password email: ' + err.message);
      throw new InternalServerErrorException(
        'Error al enviar el correo con la contraseña',
      );
    }
  }

  async verifyBlogPassword(password: string): Promise<boolean> {
    try {
      const record = await this.prisma.blogPassword.findFirst({
        where: { isUsed: false, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      });

      const hashToCompare = record?.password ?? DUMMY_HASH;
      const isValid = await bcrypt.compare(password, hashToCompare);

      if (isValid && record) {
        await this.prisma.blogPassword.update({
          where: { id: record.id },
          data: { isUsed: true },
        });
        return true;
      }

      return false;
    } catch (err) {
      this.logger.error('verifyBlogPassword error: ' + err.message);
      return false;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PASSWORD RESET FLOW
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Generate a one-time reset token, store it on the user, and email a link.
   * Always returns success to prevent email enumeration attacks.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email: normalizedEmail } });

    // Don't reveal whether the email exists — always succeed silently
    if (!user) {
      this.logger.log(`Password reset requested for non-existent email: ${normalizedEmail}`);
      return;
    }

    // Generate a cryptographically random token
    const token = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await this.prisma.user.update({
      where: { id: user.id },
      data:  { resetToken: token, resetTokenExpiry: expiry },
    });

    try {
      await this.emailService.sendPasswordResetEmail(user.email, token, user.name);
      this.logger.log(`Password reset email sent to ${user.email}`);
    } catch (err: any) {
      this.logger.error(`Failed to send reset email to ${user.email}: ${err.message}`);
      // Don't throw — don't reveal email-sending failures to the client
    }
  }

  /**
   * Validate a reset token without consuming it (for the reset page to verify
   * the link is valid before showing the password form).
   */
  async validateResetToken(token: string): Promise<{ valid: boolean; email?: string }> {
    if (!token || typeof token !== 'string') return { valid: false };

    const user = await this.prisma.user.findFirst({
      where: {
        resetToken: token,
        resetTokenExpiry: { gt: new Date() },
      },
      select: { email: true },
    });

    if (!user) return { valid: false };
    return { valid: true, email: user.email };
  }

  /**
   * Consume a reset token and set a new password.
   */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    if (!token || typeof token !== 'string') {
      throw new BadRequestException('Token inválido.');
    }
    if (!newPassword || newPassword.length < 8) {
      throw new BadRequestException('La contraseña debe tener al menos 8 caracteres.');
    }

    const user = await this.prisma.user.findFirst({
      where: {
        resetToken: token,
        resetTokenExpiry: { gt: new Date() },
      },
    });

    if (!user) {
      throw new BadRequestException('Token inválido o expirado. Solicita un nuevo enlace.');
    }

    const hashed = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        password:         hashed,
        resetToken:       null,
        resetTokenExpiry: null,
      },
    });

    this.logger.log(`Password reset completed for ${user.email}`);
  }
}