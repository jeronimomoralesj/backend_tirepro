// src/email/email.service.ts
import {
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import {
  wrapEmail,
  emailButton,
  emailLead,
  emailText,
  emailCallout,
  emailKvList,
  emailProductCard,
  emailDivider,
  emailLabel,
  emailFallbackLink,
  fmtCOP,
} from './email-templates';

const APP_URL = 'https://tirepro.com.co';
const DASHBOARD_URL = `${APP_URL}/dashboard`;
const MARKETPLACE_URL = `${APP_URL}/marketplace`;

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

  /**
   * Strip an HTML body down to a plain-text equivalent. Spam filters
   * (Gmail's especially) heavily penalise HTML-only emails — having a
   * matching `text/plain` part is one of the cheapest deliverability
   * wins available to a transactional sender.
   */
  private htmlToPlainText(html: string): string {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<\/?(p|div|tr|td|h[1-6]|li|br)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
  }

  async sendEmail(to: string, subject: string, htmlContent: string) {
    if (!this.transporter) {
      throw new InternalServerErrorException('Email service not initialized');
    }

    // Deliverability helpers — avoid the spam folder:
    //  1. multipart/alternative with a real text/plain body. HTML-only
    //     mail is the single biggest "this is spam" signal Gmail uses.
    //  2. Reply-To pointing at a real, monitored inbox. The from address
    //     can be a generic noreply but RFC 5322 wants a deliverable
    //     reply path or filters get suspicious.
    //  3. List-Unsubscribe header (RFC 2369). Even on transactional
    //     mail, having one signals "legit sender" to Gmail/Outlook.
    //  4. Message-ID host pinned to the sender domain so it lines up
    //     with SPF/DKIM rather than nodemailer's default `@localhost`.
    const fromDomain = (this.fromAddress.split('@')[1] ?? 'tirepro.com.co').trim();
    const mailOptions: nodemailer.SendMailOptions = {
      from: `"TirePro" <${this.fromAddress}>`,
      to,
      replyTo: 'info@tirepro.com.co',
      subject,
      html: htmlContent,
      text: this.htmlToPlainText(htmlContent),
      messageId: `<${Date.now()}-${Math.random().toString(36).slice(2)}@${fromDomain}>`,
      headers: {
        'List-Unsubscribe': '<mailto:info@tirepro.com.co?subject=unsubscribe>',
        'X-Mailer': 'TirePro',
      },
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

  // ===========================================================================
  // VERIFICATION (English) — kept for API parity; defaults to Spanish flow.
  // ===========================================================================

  async sendWelcomeEmailWithVerification(email: string, name: string, verifyLink: string) {
    const subject = 'Verify your TirePro account';
    const html = wrapEmail({
      preheader: 'Confirm your email to activate your TirePro account.',
      eyebrow: 'TirePro · Welcome',
      title: `Welcome, ${name.split(' ')[0] || 'there'}.`,
      subtitle: 'One quick step before you start: confirm this is your email address.',
      body: [
        emailLead("Tap the button below to verify your email and unlock your TirePro account."),
        emailButton('Verify my email', verifyLink, { size: 'lg' }),
        emailFallbackLink(verifyLink, 'Or paste this URL in your browser:'),
        emailDivider(),
        emailCallout({
          tone: 'warning',
          title: 'Heads up',
          body: 'This link expires in 24 hours. If you didn\'t request this account, you can safely ignore this email.',
        }),
      ].join(''),
    });
    await this.sendEmail(email, subject, html);
  }

  // ===========================================================================
  // VERIFICATION (Spanish) — primary flow.
  // ===========================================================================

  async sendWelcomeEmailWithVerificationEs(email: string, name: string, verifyLink: string) {
    const subject = 'Confirma tu correo en TirePro';
    const firstName = name.split(' ')[0] || 'hola';
    const html = wrapEmail({
      preheader: 'Confirma tu correo para activar tu cuenta de TirePro.',
      eyebrow: 'TirePro · Bienvenida',
      title: `Hola, ${firstName}.`,
      subtitle: 'Un paso rápido antes de empezar: confirma que este es tu correo.',
      body: [
        emailLead('Pulsa el botón para verificar tu correo y activar tu cuenta en TirePro.'),
        emailButton('Confirmar mi correo', verifyLink, { size: 'lg' }),
        emailFallbackLink(verifyLink, 'O pega este enlace en tu navegador:'),
        emailDivider(),
        emailCallout({
          tone: 'warning',
          title: 'Importante',
          body: 'Este enlace expira en 24 horas. Si no creaste esta cuenta, puedes ignorar este correo sin problema.',
        }),
      ].join(''),
    });
    await this.sendEmail(email, subject, html);
  }

  // ===========================================================================
  // POST-VERIFICATION WELCOME — call sites gate by user type to suppress
  // for marketplace-only users (just buying tires) and for distribuidor
  // accounts (different onboarding entirely). The Spanish version is the
  // default; the English variant is kept for API parity but rarely sent.
  // ===========================================================================

  async sendWelcomeEmail(to: string, name: string) {
    const firstName = name.split(' ')[0] || 'there';
    const subject = `${firstName}, welcome to TirePro 🎉`;
    const html = wrapEmail({
      preheader: 'Your account is ready. Here\'s what to do first.',
      eyebrow: 'Account activated',
      title: `${firstName}, you're in.`,
      subtitle: 'Your fleet, your tires, your data — all in one place.',
      body: [
        emailLead('Welcome to TirePro. Your account is verified and ready to use.'),
        emailLabel('Where to start'),
        emailText('• <strong>Add your fleet</strong> and run your first tire inspection.'),
        emailText('• <strong>Track CPK and km</strong> to spot underperforming tires before they cost you.'),
        emailText('• <strong>Connect with distributors</strong> for retreads and replacements without leaving the dashboard.'),
        emailButton('Open my dashboard', DASHBOARD_URL, { size: 'lg' }),
        emailDivider(),
        emailText('Need a hand? Reply to this email — a real human reads every message.'),
      ].join(''),
    });
    return this.sendEmail(to, subject, html);
  }

  async sendWelcomeEmailEs(to: string, name: string) {
    const firstName = name.split(' ')[0] || 'hola';
    const subject = `${firstName}, bienvenido a TirePro 🎉`;
    const html = wrapEmail({
      preheader: 'Tu cuenta está lista. Esto es lo primero que puedes hacer.',
      eyebrow: 'Cuenta activada',
      title: `${firstName}, ya estás dentro.`,
      subtitle: 'Tu flota, tus llantas, tus datos — todo en un solo lugar.',
      body: [
        emailLead('Bienvenido a TirePro. Tu cuenta quedó verificada y lista para usar.'),
        emailLabel('Por dónde empezar'),
        emailText('• <strong>Carga tus vehículos</strong> y haz la primera inspección de llantas.'),
        emailText('• <strong>Sigue el CPK y los kilómetros</strong> para detectar llantas que rinden por debajo antes de que cueste plata.'),
        emailText('• <strong>Conéctate con distribuidores</strong> para reencauches y reemplazos sin salir del dashboard.'),
        emailButton('Ir a mi dashboard', DASHBOARD_URL, { size: 'lg' }),
        emailDivider(),
        emailText('¿Necesitas ayuda? Responde este correo — leemos cada mensaje.'),
      ].join(''),
    });
    return this.sendEmail(to, subject, html);
  }

  // ===========================================================================
  // PASSWORD RESET
  // ===========================================================================

  async sendPasswordResetEmail(to: string, resetToken: string, userName?: string) {
    const subject = 'Restablecer tu contraseña en TirePro';
    const resetUrl = `${APP_URL}/reset-password?token=${encodeURIComponent(resetToken)}`;
    const greet = userName ? userName.split(' ')[0] : null;
    const html = wrapEmail({
      preheader: 'Solicitaste restablecer tu contraseña en TirePro.',
      eyebrow: 'Seguridad de la cuenta',
      title: greet ? `Hola, ${greet}.` : 'Restablece tu contraseña',
      subtitle: 'Recibimos una solicitud para crear una contraseña nueva en tu cuenta.',
      body: [
        emailLead('Pulsa el botón para elegir una nueva contraseña. Si no fuiste tú quien solicitó este cambio, ignora este correo y tu contraseña actual seguirá funcionando.'),
        emailButton('Restablecer contraseña', resetUrl, { size: 'lg' }),
        emailFallbackLink(resetUrl, 'O pega este enlace en tu navegador:'),
        emailDivider(),
        emailCallout({
          tone: 'warning',
          title: 'Este enlace expira en 1 hora',
          body: 'Por seguridad, el enlace solo funciona durante 60 minutos. Si caduca, puedes solicitar otro desde la pantalla de inicio de sesión.',
        }),
      ].join(''),
    });
    return this.sendEmail(to, subject, html);
  }

  // ===========================================================================
  // COMPANY INVITE
  // ===========================================================================

  async sendCompanyInvite(to: string, companyName: string, inviteLink: string) {
    const subject = `Te invitaron a ${companyName} en TirePro`;
    const html = wrapEmail({
      preheader: `${companyName} quiere que te unas a su equipo en TirePro.`,
      eyebrow: 'Invitación a equipo',
      title: `Te invitaron a ${companyName}`,
      subtitle: 'El administrador del equipo agregó tu correo como miembro.',
      body: [
        emailLead(`<strong>${companyName}</strong> te está invitando a unirte a su equipo en TirePro. Acepta la invitación para crear tu cuenta y empezar a colaborar con su flota.`),
        emailButton('Aceptar invitación', inviteLink, { size: 'lg' }),
        emailFallbackLink(inviteLink, 'O pega este enlace:'),
        emailDivider(),
        emailText('Si no esperabas esta invitación, puedes ignorar este correo. No se creará ninguna cuenta a tu nombre hasta que aceptes.'),
      ].join(''),
    });
    return this.sendEmail(to, subject, html);
  }

  // ===========================================================================
  // PURCHASE PROPOSAL — distributor-side notification of a new bid request.
  // ===========================================================================

  async sendPurchaseProposalNotification(
    distributorEmail: string,
    clientName: string,
    itemSummary: string,
    urgency: string,
  ) {
    const subject = `Nueva solicitud de compra de ${clientName}`;
    const html = wrapEmail({
      preheader: `${clientName} envió una solicitud de cotización.`,
      eyebrow: 'Nueva solicitud',
      title: 'Tienes una nueva solicitud de compra',
      subtitle: `${clientName} pidió una cotización a través de TirePro.`,
      body: [
        emailLead(`<strong>${clientName}</strong> envió una solicitud y necesita una cotización tuya. Revisa los detalles en TirePro y responde con tu propuesta.`),
        emailKvList([
          { label: 'Resumen de la solicitud', value: itemSummary, bold: true },
          { label: 'Urgencia',                value: urgency },
        ]),
        emailButton('Ver solicitud en TirePro', `${DASHBOARD_URL}/pedidosDist`, { size: 'lg' }),
        emailDivider(),
        emailText('Las cotizaciones se cierran rápido — entra y responde lo antes posible.'),
      ].join(''),
    });
    return this.sendEmail(distributorEmail, subject, html);
  }

  // ===========================================================================
  // DRIVER ALERT — kept as plain text for SMS/WhatsApp parity, plus an
  // HTML wrapper for the email side. The `generateDriverAlertMessage`
  // method below builds the plaintext body that both channels share.
  // ===========================================================================

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

  async sendDriverAlertEmail(
    driverEmail: string,
    driverName: string,
    messageText: string,
  ) {
    const subject = '⚠️ Alerta TirePro — Acción requerida';
    const linkMatch = messageText.match(/https?:\/\/[^\s]+/);
    const confirmLink = linkMatch ? linkMatch[0] : APP_URL;

    // Pull the structured fields out of the plaintext body so we can
    // render them as a clean key-value list instead of a wall of <pre>.
    const placa    = messageText.match(/Vehículo:\s*(.+)/)?.[1]?.trim() ?? '—';
    const tireLine = messageText.match(/Llanta:\s*(.+)/)?.[1]?.trim() ?? '—';
    const issue    = messageText.match(/Problema:\s*(.+)/)?.[1]?.trim() ?? '—';
    const actionMatch = messageText.match(/Acción requerida:\n([\s\S]+?)\n\n/);
    const action   = actionMatch?.[1]?.trim() ?? '—';

    const firstName = driverName.split(' ')[0] || 'conductor';
    const html = wrapEmail({
      accent: 'warning',
      preheader: 'Una de tus llantas necesita atención inmediata.',
      eyebrow: 'Alerta de inspección',
      title: `${firstName}, hay una llanta que revisar`,
      subtitle: 'Detectamos algo que necesita acción de tu parte.',
      body: [
        emailLead('Por favor revisa el detalle a continuación y confirma cuando hayas completado la acción.'),
        emailKvList([
          { label: 'Vehículo', value: placa, bold: true },
          { label: 'Llanta',   value: tireLine },
          { label: 'Problema', value: issue },
        ]),
        emailCallout({
          tone: 'warning',
          title: 'Acción requerida',
          body: action.replace(/\n/g, '<br/>'),
        }),
        emailButton('Confirmar acción realizada', confirmLink, { color: 'success', size: 'lg' }),
        emailDivider(),
        emailText('Si tienes dudas, contacta a tu supervisor antes de hacer cambios.'),
      ].join(''),
    });
    return this.sendEmail(driverEmail, subject, html);
  }

  // ===========================================================================
  // MARKETPLACE — order lifecycle emails. Centralised here so every
  // status change flows through the same template, and the buyer's
  // tracking link is appended automatically.
  // ===========================================================================

  /**
   * Build the buyer-facing tracking URL. Used in every order email so
   * the buyer always has a one-click path back to their order detail.
   */
  buildOrderTrackingUrl(orderId: string, buyerEmail: string): string {
    return `${MARKETPLACE_URL}/order/${orderId}?email=${encodeURIComponent(buyerEmail)}`;
  }

  async sendOrderConfirmation(opts: {
    buyerEmail: string;
    buyerName: string;
    orderId: string;
    distributorName: string;
    listing: { marca: string; modelo: string; dimension: string; imageUrl?: string | null };
    quantity: number;
    totalCop: number;
    buyerAddress?: string | null;
    buyerCity?: string | null;
  }) {
    const orderNo = opts.orderId.slice(0, 8).toUpperCase();
    const trackUrl = this.buildOrderTrackingUrl(opts.orderId, opts.buyerEmail);
    const firstName = opts.buyerName.split(' ')[0] || 'hola';
    const html = wrapEmail({
      preheader: `Tu pedido #${orderNo} fue recibido por ${opts.distributorName}.`,
      eyebrow: 'Pedido recibido',
      title: `${firstName}, recibimos tu pedido`,
      subtitle: `${opts.distributorName} se comunicará contigo para coordinar la entrega.`,
      body: [
        emailLead('Gracias por tu compra. Aquí tienes el resumen de tu pedido:'),
        emailProductCard({
          imageUrl: opts.listing.imageUrl,
          marca: opts.listing.marca,
          modelo: opts.listing.modelo,
          dimension: opts.listing.dimension,
          quantity: opts.quantity,
          totalLabel: 'Total',
          totalValue: fmtCOP(opts.totalCop),
        }),
        emailKvList([
          { label: 'Pedido',       value: `#${orderNo}` },
          { label: 'Distribuidor', value: opts.distributorName },
          ...(opts.buyerAddress || opts.buyerCity ? [{
            label: 'Entrega',
            value: [opts.buyerAddress, opts.buyerCity].filter(Boolean).join(', '),
          }] : []),
        ]),
        emailButton('Seguir mi pedido', trackUrl, { size: 'lg' }),
        emailFallbackLink(trackUrl),
        emailDivider(),
        emailText('Te avisaremos por correo cada vez que el estado del pedido cambie.'),
      ].join(''),
    });
    return this.sendEmail(opts.buyerEmail, `Pedido recibido — ${opts.listing.marca} ${opts.listing.modelo}`, html);
  }

  async sendOrderConfirmedByDistributor(opts: {
    buyerEmail: string;
    buyerName: string;
    orderId: string;
    distributorName: string;
    distributorPhone?: string | null;
    listing: { marca: string; modelo: string; dimension: string; imageUrl?: string | null };
    quantity: number;
    totalCop: number;
    etaDate?: Date | string | null;
  }) {
    const orderNo = opts.orderId.slice(0, 8).toUpperCase();
    const trackUrl = this.buildOrderTrackingUrl(opts.orderId, opts.buyerEmail);
    const firstName = opts.buyerName.split(' ')[0] || 'hola';
    // Format the ETA in the buyer's locale so it reads as a real date
    // ("12 de mayo de 2026") instead of an ISO blob.
    const etaLabel = opts.etaDate
      ? new Date(opts.etaDate).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' })
      : null;
    const html = wrapEmail({
      accent: 'success',
      preheader: etaLabel
        ? `${opts.distributorName} confirmó tu pedido #${orderNo} · entrega estimada ${etaLabel}.`
        : `${opts.distributorName} confirmó tu pedido #${orderNo}.`,
      eyebrow: 'Pedido confirmado',
      title: `${firstName}, tu pedido fue confirmado`,
      subtitle: etaLabel
        ? `${opts.distributorName} aprobó el pedido. Entrega estimada: ${etaLabel}.`
        : `${opts.distributorName} aprobó el pedido y se comunicará contigo para coordinar la entrega.`,
      body: [
        emailLead('Excelentes noticias — el distribuidor ya tiene tu pedido en preparación.'),
        ...(etaLabel
          ? [emailCallout({
              tone: 'success',
              title: 'Entrega estimada',
              body: `<strong>${etaLabel}</strong>`,
            })]
          : []),
        emailProductCard({
          imageUrl: opts.listing.imageUrl,
          marca: opts.listing.marca,
          modelo: opts.listing.modelo,
          dimension: opts.listing.dimension,
          quantity: opts.quantity,
          totalLabel: 'Total',
          totalValue: fmtCOP(opts.totalCop),
        }),
        emailKvList([
          { label: 'Pedido', value: `#${orderNo}` },
          ...(etaLabel ? [{ label: 'Entrega estimada', value: etaLabel, bold: true }] : []),
          ...(opts.distributorPhone ? [{ label: 'Teléfono distribuidor', value: opts.distributorPhone }] : []),
        ]),
        emailButton('Seguir mi pedido', trackUrl, { color: 'success', size: 'lg' }),
        emailFallbackLink(trackUrl),
      ].join(''),
    });
    return this.sendEmail(opts.buyerEmail, `Pedido confirmado — ${opts.listing.marca} ${opts.listing.modelo}`, html);
  }

  async sendOrderCancelled(opts: {
    buyerEmail: string;
    buyerName: string;
    orderId: string;
    distributorName: string;
    listing: { marca: string; modelo: string; dimension: string; imageUrl?: string | null };
    quantity: number;
    totalCop: number;
    cancelReason?: string | null;
  }) {
    const orderNo = opts.orderId.slice(0, 8).toUpperCase();
    const trackUrl = this.buildOrderTrackingUrl(opts.orderId, opts.buyerEmail);
    const firstName = opts.buyerName.split(' ')[0] || 'hola';
    const html = wrapEmail({
      accent: 'danger',
      preheader: `Tu pedido #${orderNo} fue cancelado.`,
      eyebrow: 'Pedido cancelado',
      title: `${firstName}, tu pedido fue cancelado`,
      subtitle: `${opts.distributorName} canceló este pedido. Esto es lo que sabemos.`,
      body: [
        emailLead('Lamentamos que tu pedido no se haya podido completar. Aquí tienes los detalles:'),
        emailCallout({
          tone: 'danger',
          title: 'Motivo de cancelación',
          body: opts.cancelReason ? opts.cancelReason : 'No fue especificado por el distribuidor.',
        }),
        emailProductCard({
          imageUrl: opts.listing.imageUrl,
          marca: opts.listing.marca,
          modelo: opts.listing.modelo,
          dimension: opts.listing.dimension,
          quantity: opts.quantity,
          totalLabel: 'Total',
          totalValue: fmtCOP(opts.totalCop),
        }),
        emailKvList([
          { label: 'Pedido',       value: `#${orderNo}` },
          { label: 'Distribuidor', value: opts.distributorName },
        ]),
        emailButton('Ver detalle del pedido', trackUrl),
        emailDivider(),
        emailText('¿Quieres seguir buscando este producto? En el marketplace puedes comparar otros distribuidores que lo tengan disponible.'),
        emailButton('Ir al Marketplace', MARKETPLACE_URL, { color: 'brand' }),
      ].join(''),
    });
    return this.sendEmail(opts.buyerEmail, `Pedido cancelado — ${opts.listing.marca} ${opts.listing.modelo}`, html);
  }

  async sendOrderStatusChanged(opts: {
    buyerEmail: string;
    buyerName: string;
    orderId: string;
    newStatus: string;
    distributorName: string;
    distributorPhone?: string | null;
    listing: { marca: string; modelo: string; dimension: string; imageUrl?: string | null };
    quantity: number;
    totalCop: number;
  }) {
    const orderNo = opts.orderId.slice(0, 8).toUpperCase();
    const trackUrl = this.buildOrderTrackingUrl(opts.orderId, opts.buyerEmail);
    const firstName = opts.buyerName.split(' ')[0] || 'hola';
    const isDelivered = opts.newStatus === 'entregado';
    const accent: 'success' | 'brand' = isDelivered ? 'success' : 'brand';
    const eyebrow = isDelivered ? 'Pedido entregado' : 'Estado actualizado';
    const title = isDelivered
      ? `¡Tu pedido fue entregado, ${firstName}!`
      : `${firstName}, tu pedido se actualizó`;
    const subtitle = isDelivered
      ? `${opts.distributorName} marcó tu pedido como entregado. ¡Gracias por tu compra!`
      : `${opts.distributorName} actualizó el estado de tu pedido a "${opts.newStatus}".`;
    const html = wrapEmail({
      accent,
      preheader: `Pedido #${orderNo} — ${opts.newStatus}.`,
      eyebrow,
      title,
      subtitle,
      body: [
        emailLead(isDelivered
          ? 'Esperamos que disfrutes tu compra. Si algo no salió como esperabas, responde este correo y te ayudamos.'
          : 'Aquí tienes el detalle más reciente del pedido:'),
        emailProductCard({
          imageUrl: opts.listing.imageUrl,
          marca: opts.listing.marca,
          modelo: opts.listing.modelo,
          dimension: opts.listing.dimension,
          quantity: opts.quantity,
          totalLabel: 'Total',
          totalValue: fmtCOP(opts.totalCop),
        }),
        emailKvList([
          { label: 'Pedido',         value: `#${orderNo}` },
          { label: 'Estado actual',  value: opts.newStatus, bold: true },
          ...(opts.distributorPhone ? [{ label: 'Teléfono distribuidor', value: opts.distributorPhone }] : []),
        ]),
        emailButton(isDelivered ? 'Ver mi pedido' : 'Seguir mi pedido', trackUrl, { color: accent, size: 'lg' }),
        emailFallbackLink(trackUrl),
      ].join(''),
    });
    return this.sendEmail(opts.buyerEmail, `Pedido #${orderNo} — ${eyebrow}`, html);
  }

  async sendOrderToDistributor(opts: {
    distributorEmail: string;
    orderId: string;
    listing: { marca: string; modelo: string; dimension: string; imageUrl?: string | null };
    quantity: number;
    totalCop: number;
    buyerName: string;
    buyerPhone?: string | null;
    buyerCity?: string | null;
  }) {
    const orderNo = opts.orderId.slice(0, 8).toUpperCase();
    const html = wrapEmail({
      preheader: `Nuevo pedido en el marketplace por ${fmtCOP(opts.totalCop)}.`,
      eyebrow: 'Nuevo pedido',
      title: 'Te llegó un pedido nuevo',
      subtitle: `Cliente: ${opts.buyerName}${opts.buyerCity ? ` · ${opts.buyerCity}` : ''}`,
      body: [
        emailLead('Un cliente acaba de comprar uno de tus productos en el marketplace. Confirma o gestiona el pedido desde tu panel.'),
        emailProductCard({
          imageUrl: opts.listing.imageUrl,
          marca: opts.listing.marca,
          modelo: opts.listing.modelo,
          dimension: opts.listing.dimension,
          quantity: opts.quantity,
          totalLabel: 'Total',
          totalValue: fmtCOP(opts.totalCop),
        }),
        emailKvList([
          { label: 'Pedido',       value: `#${orderNo}` },
          { label: 'Comprador',    value: opts.buyerName },
          ...(opts.buyerPhone ? [{ label: 'Teléfono', value: opts.buyerPhone }] : []),
          ...(opts.buyerCity  ? [{ label: 'Ciudad',   value: opts.buyerCity  }] : []),
        ]),
        emailButton('Ver pedido en mi panel', `${DASHBOARD_URL}/marketplace/pedidos`, { size: 'lg' }),
      ].join(''),
    });
    return this.sendEmail(opts.distributorEmail, `Nuevo pedido — ${opts.listing.marca} ${opts.listing.modelo}`, html);
  }
}
