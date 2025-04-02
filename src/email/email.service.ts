import { Injectable, InternalServerErrorException } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

@Injectable()
export class EmailService {
  private transporter: nodemailer.Transporter;

  constructor() {
    // Validate environment variables
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      throw new InternalServerErrorException('Missing email credentials in environment variables');
    }

    this.transporter = nodemailer.createTransport({
      service: process.env.EMAIL_SERVICE || 'gmail', 
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
      console.log(`Email sent to ${to}`);
      return { message: 'Email sent successfully' };
    } catch (error) {
      console.error("Error sending email:", error.message);
      throw new InternalServerErrorException("Failed to send email");
    }
  }

  async sendWelcomeEmail(to: string, name: string) {
    const htmlContent = `
      <h2>Hola ${name}, ¡Bienvenido a TirePro! 🚀</h2>
      <p>Estamos emocionados de tenerte en nuestra plataforma. Ahora puedes gestionar tus llantas de manera eficiente.</p>
      <p>Si tienes alguna pregunta, no dudes en contactarnos.</p>
      <br/>
      <p>Saludos,<br/><strong>Equipo TirePro</strong></p>
    `;
    return this.sendEmail(to, "¡Bienvenido a TirePro! 🚀", htmlContent);
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
    return this.sendEmail(to, "Restablecer contraseña", htmlContent);
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
