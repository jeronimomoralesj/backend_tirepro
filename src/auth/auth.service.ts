import { Injectable, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { MailerService } from '@nestjs-modules/mailer';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly mailerService: MailerService
  ) {}

  async generateJwt(user: { email: string; id: string }) {
    return this.jwtService.sign({ email: user.email, sub: user.id });
  }

  async register(email: string, name: string, password: string) {
    const existingUser = await this.prisma.user.findUnique({ where: { email } });
    if (existingUser) throw new BadRequestException("User already exists");

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await this.prisma.user.create({
      data: { email, name, password: hashedPassword, companyId: "", role: "regular", puntos: 0, plates: [] },
    });

    return { message: "User registered successfully", userId: newUser.id };
  }

async login(email: string, password: string) {
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
    },
  });

  if (!user) {
    throw new BadRequestException('Invalid credentials');
  }

  if (!user.isVerified) {
    throw new BadRequestException('Please verify your email before logging in.');
  }

  const isPasswordValid = await bcrypt.compare(password, user.password);
  if (!isPasswordValid) {
    throw new BadRequestException('Invalid credentials');
  }

  // 🔴 INCLUDE EVERYTHING YOU NEED AT REQUEST TIME
  const payload = {
    sub: user.id,
    email: user.email,
    companyId: user.companyId,
    role: user.role,
  };

  const access_token = this.jwtService.sign(payload);

  return {
    access_token,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      companyId: user.companyId,
      name: user.name,
    },
  };
}

  async validateUser(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new UnauthorizedException('Invalid credentials');

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) throw new UnauthorizedException('Invalid credentials');

    const token = await this.generateJwt(user);

    return { token, user };
  }

  // Blog admin password functionality
  async generateBlogPassword(): Promise<void> {
    // Generate a random 12-character password
    const password = crypto.randomBytes(8).toString('hex');
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Set expiration time (24 hours from now)
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);

    // Store in database (assuming you have a blog_passwords table)
    await this.prisma.blogPassword.upsert({
      where: { id: 1 }, // Assuming single admin password
      update: {
        password: hashedPassword,
        expiresAt: expiresAt,
        isUsed: false
      },
      create: {
        password: hashedPassword,
        expiresAt: expiresAt,
        isUsed: false
      }
    });

    // Send email with the password
    try {
      await this.mailerService.sendMail({
        to: 'info@tirepro.com.co',
        subject: 'Nueva Contraseña de Admin - Blog TirePro',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #348CCB;">Nueva Contraseña de Administrador</h2>
            <p>Se ha generado una nueva contraseña para acceder al panel de administración del blog:</p>
            <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <strong style="font-size: 18px; color: #333;">${password}</strong>
            </div>
            <p><strong>⚠️ Importante:</strong></p>
            <ul>
              <li>Esta contraseña expira en 24 horas</li>
              <li>Solo puede ser usada una vez</li>
              <li>Después de usarla, deberás generar una nueva</li>
            </ul>
            <p>Si no solicitaste esta contraseña, puedes ignorar este correo.</p>
            <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
            <p style="color: #666; font-size: 12px;">
              Este es un correo automático del sistema de administración de TirePro.
            </p>
          </div>
        `,
      });
    } catch (error) {
      console.error('Error sending email:', error);
      throw new BadRequestException('Error al enviar el correo con la contraseña');
    }
  }

  async verifyBlogPassword(password: string): Promise<boolean> {
    try {
      // Get the current password from database
      const blogPassword = await this.prisma.blogPassword.findFirst({
        where: {
          isUsed: false,
          expiresAt: {
            gt: new Date() // Not expired
          }
        },
        orderBy: {
          createdAt: 'desc'
        }
      });

      if (!blogPassword) {
        return false; // No valid password found
      }

      // Verify the password
      const isValid = await bcrypt.compare(password, blogPassword.password);
      
      if (isValid) {
        // Mark password as used
        await this.prisma.blogPassword.update({
          where: { id: blogPassword.id },
          data: { isUsed: true }
        });
      }

      return isValid;
    } catch (error) {
      console.error('Error verifying blog password:', error);
      return false;
    }
  }
}