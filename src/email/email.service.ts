// src/email/email.service.ts
import {
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger(EmailService.name);
  private transporter: nodemailer.Transporter;
  private emailUser: string;
  private emailPassword: string;
  private fromAddress: string;

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    this.emailUser     = (this.configService.get<string>('EMAIL_USER')     || '').trim();
    this.emailPassword =  this.configService.get<string>('EMAIL_PASSWORD') || '';
    // EMAIL_FROM lets you use a different envelope/display address than the
    // SMTP auth user (e.g. auth as noreply@, send as info@). Falls back to user.
    this.fromAddress   = (this.configService.get<string>('EMAIL_FROM') || this.emailUser).trim();

    if (!this.emailUser || !this.emailPassword) {
      this.logger.error('EMAIL_USER / EMAIL_PASSWORD not set — email disabled');
      throw new Error('Email credentials not configured');
    }

    // Transport config:
    //  - If EMAIL_HOST is set, use it directly (GoDaddy, Office365, etc.)
    //  - Otherwise default to Gmail (works for Google Workspace domains too)
    const host = (this.configService.get<string>('EMAIL_HOST') || '').trim();
    const transportOpts: nodemailer.TransportOptions = host
      ? ({
          host,
          port: Number(this.configService.get<string>('EMAIL_PORT') ?? 465),
          secure:
            (this.configService.get<string>('EMAIL_SECURE') ?? 'true').toLowerCase() !== 'false',
          auth: { user: this.emailUser, pass: this.emailPassword },
        } as any)
      : ({
          service: 'gmail',
          auth: { user: this.emailUser, pass: this.emailPassword },
        } as any);

    this.transporter = nodemailer.createTransport(transportOpts);

    this.logger.log(
      `SMTP transport ready — ${host ? `${host}:${(transportOpts as any).port}` : 'gmail'} · user=${this.emailUser} · from=${this.fromAddress}`,
    );

    // Don't block startup, but log the outcome so pm2 logs show the real
    // reason auth fails (wrong password, app-password required, etc.).
    this.transporter.verify().then(
      () => this.logger.log('SMTP credentials verified'),
      (err) =>
        this.logger.error(
          `SMTP verify failed: ${err?.message ?? err} ` +
            `(code=${(err as any)?.code ?? 'n/a'}, response=${(err as any)?.response ?? 'n/a'})`,
        ),
    );
  }

  async sendEmail(to: string, subject: string, htmlContent: string) {
    if (!this.transporter) {
      throw new InternalServerErrorException('Email service not initialized');
    }

    const mailOptions = {
      from: `"TirePro Support" <${this.fromAddress}>`,
      to,
      subject,
      html: htmlContent,
    };

    try {
      const info = await this.transporter.sendMail(mailOptions);
      this.logger.log(`Email sent to ${to} — messageId=${info.messageId}`);
      return { message: 'Email sent successfully', messageId: info.messageId };
    } catch (error: any) {
      // Surface the actual SMTP failure — "Failed to send email" alone is
      // unactionable when diagnosing credentials/TLS/host issues.
      this.logger.error(
        `sendMail to ${to} failed: ${error?.message ?? error} ` +
          `(code=${error?.code ?? 'n/a'}, response=${error?.response ?? 'n/a'})`,
        error?.stack,
      );
      throw new InternalServerErrorException(
        `Failed to send email: ${error?.code ?? error?.message ?? 'unknown'}`,
      );
    }
  }

  async sendWelcomeEmailWithVerification(email: string, name: string, verifyLink: string) {
    const subject = "Verify your TirePro account";
    const html = `
      <div style="font-family: 'Inter', sans-serif; line-height: 1.6; color: #0A183A; max-width: 600px; margin: 0 auto; background-color: #f8f8f8; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #0A183A; border-top-left-radius: 12px; border-top-right-radius: 12px;">
          <tr>
            <td style="padding: 30px; text-align: center;">
              <h1 style="color: #ffffff; font-size: 28px; margin: 0; padding: 0;">Welcome to TirePro!</h1>
            </td>
          </tr>
        </table>

        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; padding: 30px;">
          <tr>
            <td style="padding: 0 20px;">
              <p style="font-size: 16px; margin-bottom: 20px;">Hello ${name},</p>
              <p style="font-size: 16px; margin-bottom: 30px;">Thank you for joining the TirePro community! To activate your account and get started, please verify your email by clicking the button below:</p>

              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" style="padding-bottom: 30px;">
                    <table border="0" cellspacing="0" cellpadding="0">
                      <tr>
                        <td align="center" style="border-radius: 8px;" bgcolor="#348CCB">
                          <a href="${verifyLink}" target="_blank" style="font-size: 18px; font-family: 'Inter', sans-serif; color: #ffffff; text-decoration: none; border-radius: 8px; background-color: #348CCB; padding: 15px 25px; border: 1px solid #1E76B6; display: inline-block; font-weight: bold;">
                            Activate my account
                          </a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <p style="font-size: 13px; color: #6b7280; margin-top: 8px; word-break: break-all;">
                Or paste this link into your browser: <a href="${verifyLink}" style="color: #1E76B6;">${verifyLink}</a>
              </p>
              <p style="font-size: 13px; color: #6b7280; margin-top: 16px;">
                This link expires in 48 hours. After that, the account will be removed.
              </p>
              <p style="font-size: 14px; color: #173D68; margin-top: 20px;">If you didn't create an account, or if you received this email by mistake, please disregard it.</p>
            </td>
          </tr>
        </table>

        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #173D68; border-bottom-left-radius: 12px; border-bottom-right-radius: 12px;">
          <tr>
            <td style="padding: 20px; text-align: center;">
              <p style="font-size: 12px; color: #ffffff; margin: 0;">
                &copy; ${new Date().getFullYear()} TirePro. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </div>
    `;

    await this.sendEmail(email, subject, html);
  }

  async sendWelcomeEmailWithVerificationEs(email: string, name: string, verifyLink: string) {
    const subject = "Verifica tu cuenta de TirePro";
    const html = `
      <div style="font-family: 'Inter', sans-serif; line-height: 1.6; color: #0A183A; max-width: 600px; margin: 0 auto; background-color: #f8f8f8; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #0A183A; border-top-left-radius: 12px; border-top-right-radius: 12px;">
          <tr>
            <td style="padding: 30px; text-align: center;">
              <h1 style="color: #ffffff; font-size: 28px; margin: 0; padding: 0;">¡Bienvenido a TirePro!</h1>
            </td>
          </tr>
        </table>

        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; padding: 30px;">
          <tr>
            <td style="padding: 0 20px;">
              <p style="font-size: 16px; margin-bottom: 20px;">Hola ${name},</p>
              <p style="font-size: 16px; margin-bottom: 30px;">Gracias por crear tu cuenta en TirePro! Para activar tu cuenta por favor verifica tu correo dándole click al botón de abajo:</p>

              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" style="padding-bottom: 30px;">
                    <table border="0" cellspacing="0" cellpadding="0">
                      <tr>
                        <td align="center" style="border-radius: 8px;" bgcolor="#348CCB">
                          <a href="${verifyLink}" target="_blank" style="font-size: 18px; font-family: 'Inter', sans-serif; color: #ffffff; text-decoration: none; border-radius: 8px; background-color: #348CCB; padding: 15px 25px; border: 1px solid #1E76B6; display: inline-block; font-weight: bold;">
                            Activar mi cuenta
                          </a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <p style="font-size: 13px; color: #6b7280; margin-top: 8px; word-break: break-all;">
                O pega este enlace en tu navegador: <a href="${verifyLink}" style="color: #1E76B6;">${verifyLink}</a>
              </p>
              <p style="font-size: 13px; color: #6b7280; margin-top: 16px;">
                Este enlace expira en 48 horas. Si no lo activas, la cuenta será eliminada.
              </p>
              <p style="font-size: 14px; color: #173D68; margin-top: 20px;">Si tú no solicitaste crear una cuenta o si recibiste este correo por equivocación puedes ignorarlo.</p>
            </td>
          </tr>
        </table>

        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #173D68; border-bottom-left-radius: 12px; border-bottom-right-radius: 12px;">
          <tr>
            <td style="padding: 20px; text-align: center;">
              <p style="font-size: 12px; color: #ffffff; margin: 0;">
                &copy; ${new Date().getFullYear()} TirePro. Todos los derechos reservados.
              </p>
            </td>
          </tr>
        </table>
      </div>
    `;

    await this.sendEmail(email, subject, html);
  }

async sendWelcomeEmail(to: string, name: string) {
  const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Welcome to TirePro!</title>
      <style>
        body {
          margin: 0;
          padding: 0;
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          background-color: #f5f5f5;
          line-height: 1.6;
        }
        img{
          height:20px;
        }
        .email-container {
          max-width: 600px;
          margin: 0 auto;
          background-color: #ffffff;
          box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }
        .header {
          padding: 20px 10px;
          text-align: center;
        }
        .header h1 {
          margin: 0;
          font-size: 32px;
          font-weight: 700;
          text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
        }
          .subtitle-header{
            color: black;
          }
        .header .subtitle-header {
          font-size: 16px;
          opacity: 0.9;
          font-weight: 300;
        }
        .welcome-icon {
          font-size: 48px;
          margin-bottom: 20px;
          display: block;
        }
        .content {
          padding: 40px 30px;
          color: white;
          background: #0A183A;
        }
        .greeting {
          font-size: 24px;
          margin-bottom: 20px;
          font-weight: 600;
        }
        .main-message {
          font-size: 16px;
          margin-bottom: 30px;
        }
        .features {
          background-color: #f8f9fa;
          border-left: 4px solid #348CCB;
          padding: 20px;
          margin: 30px 0;
        }
        .features h3 {
          color: #173D68;
          margin-top: 0;
          font-size: 18px;
        }
        .features ul {
          margin: 15px 0;
          padding-left: 20px;
        }
        .features li {
          margin: 8px 0;
          color: #555555;
        }
        .cta-button {
          display: inline-block;
          background: linear-gradient(135deg, #1E76B6 0%, #348CCB 100%);
          color: white;
          padding: 15px 30px;
          text-decoration: none;
          border-radius: 8px;
          font-weight: 600;
          margin: 20px 0;
          box-shadow: 0 4px 8px rgba(30, 118, 182, 0.3);
          transition: all 0.3s ease;
        }
        .cta-button:hover {
          transform: translateY(-2px);
          box-shadow: 0 6px 12px rgba(30, 118, 182, 0.4);
        }
        .support-section {
          background-color: #f0f7ff;
          padding: 25px;
          border-radius: 8px;
          margin: 30px 0;
          border: 1px solid #e6f3ff;
        }
        .support-section h3 {
          color: #0A183A;
          margin-top: 0;
          font-size: 18px;
        }
        .support-section p{
          color:black;
        }
        .footer {
          color: black;
          padding: 30px 20px;
          text-align: center;
        }
        .footer .company-name {
          font-size: 24px;
          font-weight: 700;
          margin-bottom: 10px;
          color: #348CCB;
        }
        .footer .contact-info {
          font-size: 14px;
          opacity: 0.8;
          margin: 10px 0;
        }
        .social-links {
          margin: 20px 0;
        }
        .social-links a {
          color: #348CCB;
          text-decoration: none;
          margin: 0 10px;
          font-size: 14px;
        }
        .divider {
          height: 1px;
          background: linear-gradient(90deg, transparent, #348CCB, transparent);
          margin: 20px 0;
        }
        @media (max-width: 600px) {
          .email-container {
            margin: 0;
            border-radius: 0;
          }
          .content {
            padding: 30px 20px;
          }
          .header {
            padding: 30px 20px;
          }
          .header h1 {
            font-size: 28px;
          }
          .greeting {
            font-size: 20px;
          }
        }
      </style>
    </head>
    <body>
      <div class="email-container">
        <!-- Header -->
        <div class="header">
          <div class="welcome-icon"><img src="https://www.tirepro.com.co/_next/image?url=%2F_next%2Fstatic%2Fmedia%2Flogo_text.6327c77f.png&w=256&q=75"/></div>
          <p class="subtitle-header">Your tire management platform</p>
        </div>

        <!-- Main Content -->
        <div class="content">
          <div class="greeting">Hello ${name}!</div>

          <div class="main-message">
            <strong>Welcome to the TirePro family!</strong> We are very happy to have you here.
          </div>

          <p>We want your time here to be the best, so we prepared this message for you to get the most out of TirePro.</p>

          <div class="features">
            <h3>How to get the most out of TirePro:</h3>
            <ul>
              <li>📸 Perform frequent inspections, include photos and the three tire depths.</li>
              <li>🔍 Search and analyze your historical purchases to know how your tires have performed.</li>
              <li>📈 Check your analyst regularly so you don't miss any recommendations or alerts.</li>
              <li>⚙️ Remember to add events like rotations, life changes, etc., to keep your fleet up to date.</li>
              <li>🛠️ When your tire reaches its end, remember to add it to the platform so you can later analyze the main causes and how much money you are losing.</li>
            </ul>
          </div>

          <div style="text-align: center;">
            <a href="https://www.tirepro.com.co/login" class="cta-button">Log In</a>
          </div>

          <div class="divider"></div>

          <div class="support-section">
            <h3>🤝 Need help?</h3>
            <p>We are ready to help you. If you have questions or need support, send us an email.</p>
            <p><strong>Email:</strong> info@tirepro.com.co<br>
          </div>
        </div>

        <!-- Footer -->
        <div class="footer">
          <div class="company-name"><img src= "https://www.tirepro.com.co/_next/image?url=%2F_next%2Fstatic%2Fmedia%2Flogo_text.6327c77f.png&w=256&q=75"/></div>
          <div class="contact-info">
            info@tirepro.com.co
          </div>
          <div class="social-links">
            <a href="https://www.facebook.com/profile.php?id=61576764223742">Facebook</a>
            <a href="https://www.instagram.com/tirepro.app/">Instagram</a>
            <a href="https://www.linkedin.com/company/tirepros/">LinkedIn</a>
          </div>
          <div style="margin-top: 20px; font-size: 12px; opacity: 0.7;">
            © 2025 TirePro.
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  return this.sendEmail(to, 'Welcome to TirePro! 🚀', htmlContent);
}

  async sendWelcomeEmailEs(to: string, name: string) {
  const htmlContent = `
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>¡Bienvenido a TirePro!</title>
      <style>
        body {
          margin: 0;
          padding: 0;
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          background-color: #f5f5f5;
          line-height: 1.6;
        }
        img{
        	height:20px;
        }
        .email-container {
          max-width: 600px;
          margin: 0 auto;
          background-color: #ffffff;
          box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }
        .header {
          padding: 20px 10px;
          text-align: center;
        }
        .header h1 {
          margin: 0;
          font-size: 32px;
          font-weight: 700;
          text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
        }
          .subtitle-header{
            color: black;
          }
        .header .subtitle-header {
          font-size: 16px;
          opacity: 0.9;
          font-weight: 300;
        }
        .welcome-icon {
          font-size: 48px;
          margin-bottom: 20px;
          display: block;
        }
        .content {
          padding: 40px 30px;
          color: white;
          background: #0A183A;
        }
        .greeting {
          font-size: 24px;
          margin-bottom: 20px;
          font-weight: 600;
        }
        .main-message {
          font-size: 16px;
          margin-bottom: 30px;
        }
        .features {
          background-color: #f8f9fa;
          border-left: 4px solid #348CCB;
          padding: 20px;
          margin: 30px 0;
        }
        .features h3 {
          color: #173D68;
          margin-top: 0;
          font-size: 18px;
        }
        .features ul {
          margin: 15px 0;
          padding-left: 20px;
        }
        .features li {
          margin: 8px 0;
          color: #555555;
        }
        .cta-button {
          display: inline-block;
          background: linear-gradient(135deg, #1E76B6 0%, #348CCB 100%);
          color: white;
          padding: 15px 30px;
          text-decoration: none;
          border-radius: 8px;
          font-weight: 600;
          margin: 20px 0;
          box-shadow: 0 4px 8px rgba(30, 118, 182, 0.3);
          transition: all 0.3s ease;
        }
        .cta-button:hover {
          transform: translateY(-2px);
          box-shadow: 0 6px 12px rgba(30, 118, 182, 0.4);
        }
        .support-section {
          background-color: #f0f7ff;
          padding: 25px;
          border-radius: 8px;
          margin: 30px 0;
          border: 1px solid #e6f3ff;
        }
        .support-section h3 {
          color: #0A183A;
          margin-top: 0;
          font-size: 18px;
        }
		.support-section p{
        	color:black;
        }
        .footer {
          color: black;
          padding: 30px 20px;
          text-align: center;
        }
        .footer .company-name {
          font-size: 24px;
          font-weight: 700;
          margin-bottom: 10px;
          color: #348CCB;
        }
        .footer .contact-info {
          font-size: 14px;
          opacity: 0.8;
          margin: 10px 0;
        }
        .social-links {
          margin: 20px 0;
        }
        .social-links a {
          color: #348CCB;
          text-decoration: none;
          margin: 0 10px;
          font-size: 14px;
        }
        .divider {
          height: 1px;
          background: linear-gradient(90deg, transparent, #348CCB, transparent);
          margin: 20px 0;
        }
        @media (max-width: 600px) {
          .email-container {
            margin: 0;
            border-radius: 0;
          }
          .content {
            padding: 30px 20px;
          }
          .header {
            padding: 30px 20px;
          }
          .header h1 {
            font-size: 28px;
          }
          .greeting {
            font-size: 20px;
          }
        }
      </style>
    </head>
    <body>
      <div class="email-container">
        <!-- Header -->
        <div class="header">
          <div class="welcome-icon"><img src="https://www.tirepro.com.co/_next/image?url=%2F_next%2Fstatic%2Fmedia%2Flogo_full.44b4ba32.png&w=256&q=75"/></div>
          <p class="subtitle-header">Tu plataforma para gestión de llantas</p>
        </div>
        
        <!-- Main Content -->
        <div class="content">
          <div class="greeting">Hola ${name}!</div>
          
          <div class="main-message">
            <strong>¡Bienvenido a la familia TirePro!</strong> Estamos encantados de tenerte aquí y de que hayas dado este paso hacia el ahorro.
          </div>
          
          <p>Queremos que tu tiempo acá sea el mejor entonces preparamos este mensaje para que le saques los mejor a TirePro.</p>
          
          <div class="features">
  <h3>Como sacarle provecho a TirePro:</h3>
  <ul>
    <li>📸 Haz inspecciones seguido, incluye fotos y las tres profundidades de las llantas.</li>
    <li>🔍 Busca y analiza tus compras históricas para saber como se han comportado tus llantas.</li>
    <li>📈 Revisa tu analista seguido para no perderte ninguna recomendación o alerta.</li>
    <li>⚙️ Recuerda agregar eventos como rotaciones, cambios de vida, etc para asi mantener tu flota al dia.</li>
    <li>🛠️ Cuando tu llanta llegue a su fin recuerda agregarlo a la plataforma para despues poder analizar los principales causales y cuanto dinero estas perdiendo.</li>
  </ul>
</div>

          
          <div style="text-align: center;">
            <a href="https://www.tirepro.com.co/login" class="cta-button">Ingresa</a>
          </div>
          
          <div class="divider"></div>
          
          <div class="support-section">
            <h3>🤝 ¿Necesitas ayuda?</h3>
            <p>Estamos listo para ayudarte. Si tienes preguntas o necesitas soporte mandanos un correo o escríbenos por whatsapp</p>
            <p><strong>Email:</strong> info@tirepro.com.co<br>
            <p><strong>Whatsapp:</strong> +57 315 1349122<br>
          </div>
        </div>
        
        <!-- Footer -->
        <div class="footer">
          <div class="company-name"><img src= "https://www.tirepro.com.co/favicon.ico"/></div>
          <div class="contact-info">
            info@tirepro.com.co
          </div>
          <div class="social-links">
            <a href="https://www.facebook.com/profile.php?id=61576764223742">Facebook</a>
            <a href="https://www.instagram.com/tirepro.app/">Instagram</a>
            <a href="https://www.linkedin.com/company/tirepros/">LinkedIn</a>
          </div>
          <div style="margin-top: 20px; font-size: 12px; opacity: 0.7;">
            © 2025 TirePro.
          </div>
        </div>
      </div>
    </body>
    </html>
  `;
  
  return this.sendEmail(to, 'Bienvenido a TirePro! 🚀', htmlContent);
}

  async sendPasswordResetEmail(to: string, resetToken: string, userName?: string) {
    // Production URL — never use localhost in emails even if FRONTEND_URL is misconfigured
    const envUrl = process.env.FRONTEND_URL?.trim();
    const baseUrl = (envUrl && !envUrl.includes('localhost') && !envUrl.includes('127.0.0.1'))
      ? envUrl.replace(/\/$/, '')
      : 'https://www.tirepro.com.co';
    const resetLink = `${baseUrl}/reset-password?token=${resetToken}`;
    const greeting = userName ? `Hola ${userName},` : 'Hola,';
    const htmlContent = `
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Restablecer contraseña — TirePro</title>
      </head>
      <body style="margin:0;padding:0;background-color:#F1F5F9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#F1F5F9;padding:40px 20px;">
          <tr><td align="center">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;background-color:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(10,24,58,0.06);">
              <tr><td style="background:linear-gradient(135deg,#0A183A 0%,#173D68 50%,#1E76B6 100%);padding:32px 40px;text-align:left;">
                <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:800;letter-spacing:-0.3px;">TirePro</h1>
                <p style="margin:4px 0 0;color:#348CCB;font-size:12px;font-weight:600;letter-spacing:0.5px;text-transform:uppercase;">Gestion Inteligente de Llantas</p>
              </td></tr>
              <tr><td style="padding:40px;">
                <h2 style="margin:0 0 16px;color:#0A183A;font-size:24px;font-weight:800;letter-spacing:-0.4px;">Restablecer tu contrasena</h2>
                <p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:1.6;">${greeting}</p>
                <p style="margin:0 0 24px;color:#475569;font-size:15px;line-height:1.6;">Recibimos una solicitud para restablecer la contrasena de tu cuenta TirePro. Haz clic en el boton de abajo para crear una nueva contrasena:</p>
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto 24px;"><tr><td align="center" style="border-radius:12px;background:linear-gradient(135deg,#1E76B6 0%,#173D68 100%);box-shadow:0 4px 12px rgba(30,118,182,0.25);">
                  <a href="${resetLink}" target="_blank" style="display:inline-block;padding:14px 36px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;border-radius:12px;">Restablecer contrasena &rarr;</a>
                </td></tr></table>
                <div style="margin-top:8px;padding:16px;background-color:#F0F7FF;border-left:3px solid #348CCB;border-radius:8px;">
                  <p style="margin:0 0 6px;color:#0A183A;font-size:13px;font-weight:700;">Por tu seguridad:</p>
                  <ul style="margin:0;padding-left:18px;color:#475569;font-size:12px;line-height:1.7;">
                    <li>Este enlace expira en <strong>1 hora</strong></li>
                    <li>Solo puede usarse <strong>una vez</strong></li>
                    <li>Si no solicitaste este cambio, puedes ignorar este mensaje</li>
                  </ul>
                </div>
                <p style="margin:24px 0 0;color:#94A3B8;font-size:12px;line-height:1.6;">Si el boton no funciona, copia y pega este enlace en tu navegador:<br/><a href="${resetLink}" style="color:#1E76B6;word-break:break-all;">${resetLink}</a></p>
              </td></tr>
              <tr><td style="padding:24px 40px;background-color:#F8FAFC;border-top:1px solid #E2E8F0;">
                <p style="margin:0;color:#94A3B8;font-size:11px;line-height:1.6;text-align:center;">Este es un correo automatico, por favor no respondas directamente.<br/>&copy; ${new Date().getFullYear()} TirePro &middot; Gestion inteligente de llantas</p>
              </td></tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `;
    return this.sendEmail(to, 'Restablecer tu contrasena de TirePro', htmlContent);
  }

  async sendCompanyInvite(to: string, companyName: string, inviteLink: string) {
    const htmlContent = `
      <h2>¡Te han invitado a unirte a ${companyName} en TirePro! 🚀</h2>
      <p>Haz clic en el botón de abajo para aceptar la invitación:</p>
      <a href="${inviteLink}" style="background-color:#28a745;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;">
        Unirme a ${companyName}
      </a>
      <p>Si no esperabas esta invitación, puedes ignorar este mensaje.</p>
      <br/>
      <p>Saludos,<br/><strong>Equipo TirePro</strong></p>
    `;
    return this.sendEmail(to, `Invitación a ${companyName} en TirePro`, htmlContent);
  }

  // ── Purchase proposal notification ──────────────────────────────────────────

  async sendPurchaseProposalNotification(
    distributorEmail: string,
    clientName: string,
    itemSummary: string,
    urgency: string,
  ) {
    const html = `
      <div style="font-family: 'Inter', sans-serif; line-height: 1.6; color: #0A183A; max-width: 600px; margin: 0 auto; background-color: #f8f8f8; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #0A183A; border-top-left-radius: 12px; border-top-right-radius: 12px;">
          <tr>
            <td style="padding: 30px; text-align: center;">
              <h1 style="color: #ffffff; font-size: 22px; margin: 0;">Nueva Solicitud de Compra</h1>
            </td>
          </tr>
        </table>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; padding: 30px;">
          <tr>
            <td style="padding: 24px;">
              <p style="font-size: 16px; margin-bottom: 16px; color: #0A183A;">
                <strong>${clientName}</strong> ha enviado una solicitud de compra.
              </p>
              <div style="background: #f0f7ff; border-left: 4px solid #1E76B6; padding: 16px; border-radius: 8px; margin-bottom: 16px;">
                <p style="font-size: 14px; color: #173D68; margin: 0 0 8px 0;"><strong>Resumen:</strong> ${itemSummary}</p>
                <p style="font-size: 14px; color: #173D68; margin: 0;"><strong>Urgencia:</strong> ${urgency}</p>
              </div>
              <p style="font-size: 14px; color: #64748b; margin-bottom: 24px;">
                Ingresa a TirePro para revisar los detalles y enviar tu cotizacion.
              </p>
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center">
                    <a href="https://tirepro.com.co/dashboard/pedidosDist" style="font-size: 16px; color: #ffffff; text-decoration: none; border-radius: 8px; background-color: #348CCB; padding: 14px 28px; border: 1px solid #1E76B6; display: inline-block; font-weight: bold;">
                      Ver Solicitud
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #173D68; border-bottom-left-radius: 12px; border-bottom-right-radius: 12px;">
          <tr>
            <td style="padding: 20px; text-align: center;">
              <p style="font-size: 12px; color: #ffffff; margin: 0;">&copy; ${new Date().getFullYear()} TirePro. Todos los derechos reservados.</p>
            </td>
          </tr>
        </table>
      </div>
    `;

    return this.sendEmail(distributorEmail, 'Nueva Solicitud de Compra — TirePro', html);
  }

  // ── Driver alert message (plain text for WhatsApp/SMS) ──────────────────────

  generateDriverAlertMessage(
    vehiclePlaca: string,
    tirePlaca: string,
    tirePosition: number,
    issue: string,
    action: string,
    confirmLink: string,
  ): string {
    return [
      `⚠️ Alerta TirePro`,
      `🚛 Vehículo: ${vehiclePlaca}`,
      `🔧 Llanta: ${tirePlaca} (Posición ${tirePosition})`,
      ``,
      `Problema: ${issue}`,
      ``,
      `Acción requerida:`,
      action,
      ``,
      `✅ Cuando hayas completado la acción, confirma aquí:`,
      confirmLink,
      ``,
      `Si tienes dudas, contacta a tu supervisor.`,
    ].join('\n');
  }

  // ── Driver alert email (wraps plain text in HTML template) ──────────────────

  async sendDriverAlertEmail(
    driverEmail: string,
    driverName: string,
    messageText: string,
  ) {
    // Extract confirm link from message text
    const linkMatch = messageText.match(/https?:\/\/[^\s]+/);
    const confirmLink = linkMatch ? linkMatch[0] : 'https://tirepro.com.co';

    // Escape HTML and convert newlines to <br>
    const bodyHtml = messageText
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');

    const html = `
      <div style="font-family: 'Inter', sans-serif; line-height: 1.6; color: #0A183A; max-width: 600px; margin: 0 auto; background-color: #f8f8f8; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #0A183A; border-top-left-radius: 12px; border-top-right-radius: 12px;">
          <tr>
            <td style="padding: 30px; text-align: center;">
              <h1 style="color: #ffffff; font-size: 22px; margin: 0;">Alerta TirePro</h1>
              <p style="color: rgba(255,255,255,0.6); font-size: 14px; margin: 8px 0 0 0;">Accion Requerida</p>
            </td>
          </tr>
        </table>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; padding: 30px;">
          <tr>
            <td style="padding: 24px;">
              <p style="font-size: 16px; margin-bottom: 20px; color: #0A183A;">Hola <strong>${driverName}</strong>,</p>
              <div style="background: #fffbeb; border-left: 4px solid #f97316; padding: 16px; border-radius: 8px; margin-bottom: 24px; font-size: 14px; color: #173D68; white-space: pre-line;">
                ${bodyHtml}
              </div>
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center">
                    <a href="${confirmLink}" style="font-size: 16px; color: #ffffff; text-decoration: none; border-radius: 8px; background-color: #22c55e; padding: 14px 28px; border: 1px solid #16a34a; display: inline-block; font-weight: bold;">
                      Confirmar Accion
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #173D68; border-bottom-left-radius: 12px; border-bottom-right-radius: 12px;">
          <tr>
            <td style="padding: 20px; text-align: center;">
              <p style="font-size: 12px; color: #ffffff; margin: 0;">&copy; ${new Date().getFullYear()} TirePro. Todos los derechos reservados.</p>
            </td>
          </tr>
        </table>
      </div>
    `;

    return this.sendEmail(driverEmail, '⚠️ Alerta TirePro — Acción Requerida', html);
  }
}
