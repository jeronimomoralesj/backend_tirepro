import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateArticleDto } from './dto/create-article.dto';
import { UpdateArticleDto } from './dto/update-article.dto';
import * as nodemailer from 'nodemailer';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class BlogService {
  private transporter: nodemailer.Transporter;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.initializeTransporter();
  }

  private initializeTransporter() {
    const smtpHost = this.configService.get<string>('SMTP_HOST');
    const smtpPort = Number(this.configService.get<string>('SMTP_PORT', '587'));
    const smtpUser = this.configService.get<string>('SMTP_USER');
    const smtpPass = this.configService.get<string>('SMTP_PASS');

    console.log('SMTP Configuration:', {
      host: smtpHost,
      port: smtpPort,
      user: smtpUser ? `${smtpUser.substring(0, 3)}***` : 'NOT_SET',
      passwordSet: !!smtpPass
    });

    this.transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465, // true for 465, false for other ports
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
      // Enhanced connection options
      connectionTimeout: 60000, // 60 seconds
      greetingTimeout: 30000,   // 30 seconds  
      socketTimeout: 60000,     // 60 seconds
      logger: true,             // Enable logging
      debug: process.env.NODE_ENV === 'development', // Enable debug in dev
      // Retry settings
      pool: true,
      maxConnections: 1,
      maxMessages: 3,
    });

    // Test connection on startup
    this.testConnection();
  }

  private async testConnection() {
    try {
      await this.transporter.verify();
      console.log('✅ SMTP connection verified successfully');
    } catch (error) {
      console.error('❌ SMTP connection failed:', error.message);
      console.error('Full error:', error);
    }
  }

  // Article CRUD operations (unchanged)
  async findAll() {
    return this.prisma.article.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: number) {
    const article = await this.prisma.article.findUnique({
      where: { id },
    });

    if (!article) {
      throw new NotFoundException(`Article with ID ${id} not found`);
    }

    return article;
  }

  async create(createArticleDto: CreateArticleDto) {
    return this.prisma.article.create({
      data: {
        title: createArticleDto.title,
        subtitle: createArticleDto.subtitle,
        content: createArticleDto.content,
        coverImage: createArticleDto.coverImage,
        category: createArticleDto.category,
        hashtags: createArticleDto.hashtags || [],
      },
    });
  }

  async update(id: number, updateArticleDto: UpdateArticleDto) {
    await this.findOne(id); // This will throw if not found
    return this.prisma.article.update({
      where: { id },
      data: updateArticleDto,
    });
  }

  async remove(id: number) {
    await this.findOne(id); // This will throw if not found
    return this.prisma.article.delete({
      where: { id },
    });
  }

  // Enhanced admin password operations
  async generatePassword(): Promise<void> {
    try {
      const password = this.generateRandomPassword();
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 24);

      // Save password to database
      await this.prisma.adminPassword.create({
        data: {
          password,
          expiresAt,
        },
      });

      console.log('🔐 Password generated, attempting to send email...');
      
      // Send email with retry logic
      await this.sendPasswordEmailWithRetry(password);
      
      console.log('✅ Password email sent successfully');
    } catch (error) {
      console.error('❌ Error in generatePassword:', error);
      throw new BadRequestException(`Error generating password: ${error.message}`);
    }
  }

  async verifyPassword(password: string): Promise<boolean> {
    const adminPassword = await this.prisma.adminPassword.findFirst({
      where: {
        password,
        used: false,
        expiresAt: {
          gt: new Date(),
        },
      },
    });

    if (!adminPassword) {
      return false;
    }

    // Mark password as used
    await this.prisma.adminPassword.update({
      where: { id: adminPassword.id },
      data: { used: true },
    });

    return true;
  }

  private generateRandomPassword(): string {
    const length = 12;
    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let password = '';
    
    for (let i = 0; i < length; i++) {
      password += charset.charAt(Math.floor(Math.random() * charset.length));
    }
    
    return password;
  }

  private async sendPasswordEmailWithRetry(password: string, maxRetries = 3): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`📧 Email attempt ${attempt}/${maxRetries}`);
        await this.sendPasswordEmail(password);
        return; // Success, exit retry loop
      } catch (error) {
        console.error(`❌ Email attempt ${attempt} failed:`, error.message);
        
        if (attempt === maxRetries) {
          throw error; // Last attempt failed, throw error
        }
        
        // Wait before retrying (exponential backoff)
        const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
        console.log(`⏳ Waiting ${delay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  private async sendPasswordEmail(password: string): Promise<void> {
    const fromEmail = this.configService.get('SMTP_FROM') || this.configService.get('SMTP_USER');
    
    const mailOptions = {
      from: fromEmail,
      to: 'info@tirepro.com.co',
      subject: 'Nueva contraseña para Admin del Blog - TirePro',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #348CCB, #1E76B6); padding: 20px; text-align: center;">
            <h1 style="color: white; margin: 0;">TirePro Blog Admin</h1>
          </div>
          
          <div style="padding: 30px; background-color: #f8f9fa;">
            <h2 style="color: #333;">Nueva contraseña generada</h2>
            <p style="color: #666; font-size: 16px;">
              Se ha generado una nueva contraseña para acceder al panel de administración del blog.
            </p>
            
            <div style="background-color: #030712; color: white; padding: 20px; border-radius: 8px; text-align: center; margin: 20px 0;">
              <h3 style="margin: 0; color: #348CCB;">Contraseña:</h3>
              <p style="font-family: 'Courier New', monospace; font-size: 18px; font-weight: bold; margin: 10px 0; letter-spacing: 2px;">
                ${password}
              </p>
            </div>
            
            <div style="background-color: #fff3cd; border: 1px solid #ffeaa7; border-radius: 8px; padding: 15px; margin: 20px 0;">
              <p style="margin: 0; color: #856404;">
                <strong>⚠️ Importante:</strong> Esta contraseña expira en 24 horas y solo puede ser utilizada una vez.
              </p>
            </div>
          </div>
          
          <div style="background-color: #e9ecef; padding: 20px; text-align: center; font-size: 12px; color: #6c757d;">
            <p style="margin: 0;">© ${new Date().getFullYear()} TirePro. Todos los derechos reservados.</p>
          </div>
        </div>
      `,
    };

    try {
      console.log('📤 Sending email to:', mailOptions.to);
      const info = await this.transporter.sendMail(mailOptions);
      console.log('✅ Email sent successfully:', info.messageId);
      console.log('📋 Response:', info.response);
    } catch (error) {
      console.error('❌ Detailed email error:', {
        message: error.message,
        code: error.code,
        command: error.command,
        response: error.response,
        responseCode: error.responseCode,
      });
      throw error;
    }
  }
}