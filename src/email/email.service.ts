import { Injectable, InternalServerErrorException } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

@Injectable()
export class EmailService {
  private transporter: nodemailer.Transporter;

  constructor() {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS || !process.env.EMAIL_SERVICE) {
      throw new InternalServerErrorException('Missing email credentials or service in environment variables');
    }

    this.transporter = nodemailer.createTransport({
      service: process.env.EMAIL_SERVICE, // "gmail"
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });
  }

  async sendEmail(to: string, subject: string, htmlContent: string) {
    const mailOptions = {
      from: `"TirePro Support" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html: htmlContent,
    };

    try {
      await this.transporter.sendMail(mailOptions);
      console.log(`✅ Email sent to ${to}`);
      return { message: 'Email sent successfully' };
    } catch (error) {
      console.error('❌ Error sending email:', error.message);
      throw new InternalServerErrorException('Failed to send email');
    }
  }

async sendWelcomeEmailWithVerification(email: string, name: string, verifyLink: string) {
  const subject = "Verify your TirePro account";
  const html = `
    <div style="font-family: 'Inter', sans-serif; line-height: 1.6; color: #0A183A; max-width: 600px; margin: 0 auto; background-color: #f8f8f8; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);">
      <!-- Header Section -->
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #0A183A; border-top-left-radius: 12px; border-top-right-radius: 12px;">
        <tr>
          <td style="padding: 30px; text-align: center;">
            <h1 style="color: #ffffff; font-size: 28px; margin: 0; padding: 0;">Welcome to TirePro!</h1>
          </td>
        </tr>
      </table>

      <!-- Body Section -->
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; padding: 30px;">
        <tr>
          <td style="padding: 0 20px;">
            <p style="font-size: 16px; margin-bottom: 20px;">Hello ${name},</p>
            <p style="font-size: 16px; margin-bottom: 30px;">Thank you for joining the TirePro community! To activate your account and get started, please verify your email by clicking the button below:</p>

            <!-- Call to Action Button -->
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" style="padding-bottom: 30px;">
                  <table border="0" cellspacing="0" cellpadding="0">
                    <tr>
                      <td align="center" style="border-radius: 8px;" bgcolor="#348CCB">
                        <a href="${verifyLink}" target="_blank" style="font-size: 18px; font-family: 'Inter', sans-serif; color: #ffffff; text-decoration: none; border-radius: 8px; background-color: #348CCB; padding: 15px 25px; border: 1px solid #1E76B6; display: inline-block; font-weight: bold;">
                          Verify My Account
                        </a>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>

            <p style="font-size: 14px; color: #173D68; margin-top: 20px;">If you didn’t create an account, or if you received this email by mistake, please disregard it.</p>
          </td>
        </tr>
      </table>

      <!-- Footer Section -->
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

  await this.sendEmail(email, subject, html); // Assume you have sendEmail method
}

async sendWelcomeEmailWithVerificationEs(email: string, name: string, verifyLink: string) {
  const subject = "Verifica tu cuenta de TirePro";
  const html = `
    <div style="font-family: 'Inter', sans-serif; line-height: 1.6; color: #0A183A; max-width: 600px; margin: 0 auto; background-color: #f8f8f8; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);">
      <!-- Header Section -->
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #0A183A; border-top-left-radius: 12px; border-top-right-radius: 12px;">
        <tr>
          <td style="padding: 30px; text-align: center;">
            <h1 style="color: #ffffff; font-size: 28px; margin: 0; padding: 0;">Bienvenido a TirePro!</h1>
          </td>
        </tr>
      </table>

      <!-- Body Section -->
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; padding: 30px;">
        <tr>
          <td style="padding: 0 20px;">
            <p style="font-size: 16px; margin-bottom: 20px;">Hola ${name},</p>
            <p style="font-size: 16px; margin-bottom: 30px;">Gracias por crear tu cuenta en TirePro! Para activar tu cuenta por favor verifica tu correo dandole click al botón de abjo:</p>

            <!-- Call to Action Button -->
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

            <p style="font-size: 14px; color: #173D68; margin-top: 20px;">Si tu no solicitaste crear una cuenta o si recibiste este correo por equivocación puedes ignorarlo.</p>
          </td>
        </tr>
      </table>

      <!-- Footer Section -->
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

  await this.sendEmail(email, subject, html); // Assume you have sendEmail method
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
          <div class="welcome-icon"><img src="https://www.tirepro.com.co/_next/image?url=%2F_next%2Fstatic%2Fmedia%2Flogo_text.6327c77f.png&w=256&q=75"/></div>
          <p class="subtitle-header">Your tire managment platform</p>
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

  async sendPasswordResetEmail(to: string, resetToken: string) {
    const resetLink = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;
    const htmlContent = `
      <h2>Restablecer contraseña</h2>
      <p>Hemos recibido una solicitud para restablecer tu contraseña. Haz clic en el enlace de abajo:</p>
      <a href="${resetLink}" style="background-color:#007bff;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;">
        Restablecer Contraseña
      </a>
      <p>Si no solicitaste este cambio, puedes ignorar este mensaje.</p>
      <br/>
      <p>Saludos,<br/><strong>Equipo TirePro</strong></p>
    `;
    return this.sendEmail(to, 'Restablecer contraseña', htmlContent);
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
}
