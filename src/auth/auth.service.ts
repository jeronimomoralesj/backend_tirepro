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
// Verification link lifetime. Matches the cleanup cron's purge threshold
// (see auth-cleanup.cron.ts) so an expired link can't outlive the account.
export const VERIFICATION_TTL_MS = 48 * 60 * 60 * 1000;

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
    // 48-hour verification window. Matches the auth-cleanup cron's purge
    // threshold, so an unclicked link expires at the same moment the
    // account becomes eligible for deletion. Picking a different number
    // here would create either zombie accounts (link valid past purge)
    // or dead links (token expired but user still exists, must re-register).
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const verificationTokenExpiresAt = new Date(Date.now() + VERIFICATION_TTL_MS);

    const user = await this.prisma.user.create({
      data: {
        email,
        name,
        password: hashed,
        companyId: null,
        role: UserRole.admin,
        userPlan: 'free',
        puntos: 0,
        // Account starts unverified — the user must click the email link
        // before they can log in. The cleanup cron deletes them after 48h
        // if they never do.
        isVerified: false,
        verificationToken,
        verificationTokenExpiresAt,
      },
    });

    // Send the verification email. Fire-and-forget — a transient SMTP
    // failure shouldn't block account creation. The user can request a
    // new link via /auth/resend-verification (TODO if needed).
    const verifyLink = this.buildVerifyLink(verificationToken);
    this.emailService
      .sendWelcomeEmailWithVerificationEs(email, name, verifyLink)
      .catch((err) =>
        this.logger.warn(`Verification email failed for ${email}: ${err.message}`),
      );

    return {
      message:
        'Account created. Check your email — you have 48 hours to verify or the account will be deleted.',
      userId: user.id,
    };
  }

  /** Build the click-through link sent in verification emails. Pinned to
   *  the production frontend even when FRONTEND_URL is misconfigured —
   *  same defensive pattern the password-reset email uses. */
  private buildVerifyLink(token: string): string {
    const envUrl = (this.configService.get<string>('FRONTEND_URL') ?? '').trim();
    const baseUrl =
      envUrl && !envUrl.includes('localhost') && !envUrl.includes('127.0.0.1')
        ? envUrl.replace(/\/$/, '')
        : 'https://www.tirepro.com.co';
    return `${baseUrl}/verify-email?token=${token}`;
  }

  // -------------------------------------------------------------------------
  // login
  // -------------------------------------------------------------------------

  async login(
    email: string,
    password: string,
    meta: { ip?: string | null; userAgent?: string | null } = {},
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
        knownIps: true,
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

    // ── Login tracking ───────────────────────────────────────────────────
    // Bump the denormalized counters on User and append a per-session row
    // to user_login_logs. Fire-and-forget: a tracking failure must never
    // block the login response.
    const ip = meta.ip?.trim() || null;
    const userAgent = meta.userAgent?.trim()?.slice(0, 500) || null;
    const knownIps = Array.isArray(user.knownIps) ? user.knownIps : [];
    const needNewIp = ip && !knownIps.includes(ip);

    Promise.all([
      this.prisma.user.update({
        where: { id: user.id },
        data: {
          lastLoginAt: new Date(),
          loginCount:  { increment: 1 },
          ...(needNewIp ? { knownIps: { push: ip } } : {}),
        },
      }),
      this.prisma.userLoginLog.create({
        data: { userId: user.id, ip, userAgent },
      }),
    ]).catch(err => this.logger.warn(`Login tracking failed for ${user.id}: ${err.message}`));

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

  // Non-consuming variant used by AdminPasswordGuard. The admin login flow
  // above burns the password (isUsed=true), so subsequent requests from the
  // /blog/admin panels can't re-verify it. We accept any password that
  // matches the active record regardless of isUsed, still bounded by
  // expiresAt. No mutation — safe to call on every request.
  async isAdminPasswordActive(password: string): Promise<boolean> {
    try {
      const record = await this.prisma.blogPassword.findFirst({
        where: { expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      });
      const hashToCompare = record?.password ?? DUMMY_HASH;
      return await bcrypt.compare(password, hashToCompare);
    } catch (err) {
      this.logger.error('isAdminPasswordActive error: ' + err.message);
      return false;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PASSWORD RESET FLOW
  // ───────────────────────────────────────────────────────────────────────────

  async requestPasswordReset(email: string): Promise<void> {
    // Wrap everything in try/catch — never throw to the client.
    // This prevents 500s AND prevents email enumeration via error messages.
    try {
      const normalizedEmail = email.trim().toLowerCase();
      const user = await this.prisma.user.findUnique({ where: { email: normalizedEmail } });
      if (!user) {
        this.logger.log(`Password reset requested for non-existent email: ${normalizedEmail}`);
        return;
      }

      const token = crypto.randomBytes(32).toString('hex');
      const expiry = new Date(Date.now() + 60 * 60 * 1000);

      try {
        await this.prisma.user.update({
          where: { id: user.id },
          data:  { resetToken: token, resetTokenExpiry: expiry },
        });
      } catch (dbErr: any) {
        this.logger.error(`Reset DB update failed for ${user.email}: ${dbErr.message}`);
        return;
      }

      try {
        await this.emailService.sendPasswordResetEmail(user.email, token, user.name);
        this.logger.log(`Password reset email sent to ${user.email}`);
      } catch (mailErr: any) {
        this.logger.error(`Failed to send reset email to ${user.email}: ${mailErr.message}`);
      }
    } catch (err: any) {
      this.logger.error(`requestPasswordReset top-level error: ${err.message}`);
    }
  }

  async validateResetToken(token: string): Promise<{ valid: boolean; email?: string }> {
    if (!token || typeof token !== 'string') return { valid: false };
    const user = await this.prisma.user.findFirst({
      where: { resetToken: token, resetTokenExpiry: { gt: new Date() } },
      select: { email: true },
    });
    if (!user) return { valid: false };
    return { valid: true, email: user.email };
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    if (!token || typeof token !== 'string') {
      throw new BadRequestException('Token inválido.');
    }
    if (!newPassword || newPassword.length < 8) {
      throw new BadRequestException('La contraseña debe tener al menos 8 caracteres.');
    }
    const user = await this.prisma.user.findFirst({
      where: { resetToken: token, resetTokenExpiry: { gt: new Date() } },
    });
    if (!user) {
      throw new BadRequestException('Token inválido o expirado. Solicita un nuevo enlace.');
    }
    const hashed = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { password: hashed, resetToken: null, resetTokenExpiry: null },
    });
    this.logger.log(`Password reset completed for ${user.email}`);
  }
}