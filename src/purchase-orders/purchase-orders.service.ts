import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';

@Injectable()
export class PurchaseOrdersService {
  private readonly logger = new Logger(PurchaseOrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  // ── Create ──────────────────────────────────────────────────────────────────

  async createOrder(
    companyId: string,
    distributorId: string,
    items: any[],
    totalEstimado?: number,
    notas?: string,
  ) {
    const [company, distributor] = await Promise.all([
      this.prisma.company.findUnique({
        where: { id: companyId },
        select: { id: true, name: true },
      }),
      this.prisma.company.findUnique({
        where: { id: distributorId },
        select: { id: true, name: true, emailAtencion: true },
      }),
    ]);

    if (!company) throw new NotFoundException('Company not found');
    if (!distributor) throw new NotFoundException('Distributor not found');

    const order = await this.prisma.purchaseOrder.create({
      data: {
        companyId,
        distributorId,
        items,
        totalEstimado: totalEstimado ?? null,
        notas: notas ?? null,
      },
    });

    // Send email notification to distributor if emailAtencion is configured
    if (distributor.emailAtencion) {
      const itemCount = Array.isArray(items) ? items.length : 0;
      try {
        await this.email.sendEmail(
          distributor.emailAtencion,
          `Nueva Solicitud de Compra — ${company.name}`,
          `
          <div style="font-family: 'Inter', sans-serif; line-height: 1.6; color: #0A183A; max-width: 600px; margin: 0 auto; background-color: #f8f8f8; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #0A183A; border-top-left-radius: 12px; border-top-right-radius: 12px;">
              <tr>
                <td style="padding: 30px; text-align: center;">
                  <h1 style="color: #ffffff; font-size: 24px; margin: 0;">Nueva Solicitud de Compra</h1>
                </td>
              </tr>
            </table>
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; padding: 30px;">
              <tr>
                <td style="padding: 20px;">
                  <p style="font-size: 16px; margin-bottom: 20px;">Hola ${distributor.name},</p>
                  <p style="font-size: 16px; margin-bottom: 20px;">
                    <strong>${company.name}</strong> ha enviado una solicitud de compra de
                    <strong>${itemCount} llanta${itemCount !== 1 ? 's' : ''}</strong>.
                  </p>
                  <p style="font-size: 16px; margin-bottom: 30px;">
                    Ingresa a TirePro para ver los detalles y enviar tu cotización.
                  </p>
                  <table width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td align="center" style="padding-bottom: 20px;">
                        <a href="https://www.tirepro.com.co/login" style="font-size: 16px; color: #ffffff; text-decoration: none; border-radius: 8px; background-color: #348CCB; padding: 14px 28px; border: 1px solid #1E76B6; display: inline-block; font-weight: bold;">
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
                  <p style="font-size: 12px; color: #ffffff; margin: 0;">
                    &copy; ${new Date().getFullYear()} TirePro. Todos los derechos reservados.
                  </p>
                </td>
              </tr>
            </table>
          </div>
          `,
        );
      } catch (err) {
        // Log but don't fail the order creation if email fails
        this.logger.warn(
          `Failed to send solicitud email to ${distributor.emailAtencion}: ${err.message}`,
        );
      }
    }

    return order;
  }

  // ── Read ────────────────────────────────────────────────────────────────────

  async getOrdersForCompany(companyId: string) {
    return this.prisma.purchaseOrder.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      include: {
        distributor: { select: { id: true, name: true, profileImage: true } },
      },
    });
  }

  async getOrdersForDistributor(distributorId: string) {
    return this.prisma.purchaseOrder.findMany({
      where: { distributorId },
      orderBy: { createdAt: 'desc' },
      include: {
        company: { select: { id: true, name: true, profileImage: true } },
      },
    });
  }

  // ── Cotización ──────────────────────────────────────────────────────────────

  async submitCotizacion(
    orderId: string,
    distributorId: string,
    cotizacion: any[],
    totalCotizado: number,
    notas?: string,
  ) {
    const order = await this.prisma.purchaseOrder.findUnique({
      where: { id: orderId },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.distributorId !== distributorId) {
      throw new BadRequestException('This order does not belong to your company');
    }
    if (order.status !== 'solicitud_enviada') {
      throw new BadRequestException(`Cannot submit cotización for order in status "${order.status}"`);
    }

    return this.prisma.purchaseOrder.update({
      where: { id: orderId },
      data: {
        status: 'cotizacion_recibida',
        cotizacion,
        totalCotizado,
        cotizacionFecha: new Date(),
        cotizacionNotas: notas ?? null,
      },
    });
  }

  // ── Accept / Reject ─────────────────────────────────────────────────────────

  async acceptOrder(orderId: string, companyId: string) {
    const order = await this.prisma.purchaseOrder.findUnique({
      where: { id: orderId },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.companyId !== companyId) {
      throw new BadRequestException('This order does not belong to your company');
    }
    if (order.status !== 'cotizacion_recibida') {
      throw new BadRequestException(`Cannot accept order in status "${order.status}"`);
    }

    return this.prisma.purchaseOrder.update({
      where: { id: orderId },
      data: {
        status: 'aceptada',
        resolvedAt: new Date(),
        resolvedBy: companyId,
      },
    });
  }

  async rejectOrder(orderId: string, companyId: string, notas?: string) {
    const order = await this.prisma.purchaseOrder.findUnique({
      where: { id: orderId },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.companyId !== companyId) {
      throw new BadRequestException('This order does not belong to your company');
    }
    if (order.status !== 'cotizacion_recibida') {
      throw new BadRequestException(`Cannot reject order in status "${order.status}"`);
    }

    return this.prisma.purchaseOrder.update({
      where: { id: orderId },
      data: {
        status: 'rechazada',
        resolvedAt: new Date(),
        resolvedBy: companyId,
        notas: notas ? `${order.notas ?? ''}\n[Rechazo] ${notas}`.trim() : order.notas,
      },
    });
  }

  // ── Revision request (company asks distributor to revise) ─────────────────

  async requestRevision(orderId: string, companyId: string, notas: string) {
    const order = await this.prisma.purchaseOrder.findUnique({
      where: { id: orderId },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.companyId !== companyId) {
      throw new BadRequestException('This order does not belong to your company');
    }
    if (order.status !== 'cotizacion_recibida') {
      throw new BadRequestException(`Cannot request revision for order in status "${order.status}"`);
    }

    // Reset to solicitud_enviada so the distributor can quote again
    return this.prisma.purchaseOrder.update({
      where: { id: orderId },
      data: {
        status: 'solicitud_enviada',
        cotizacion: null,
        totalCotizado: null,
        cotizacionFecha: null,
        cotizacionNotas: null,
        notas: `${order.notas ?? ''}\n[Revisión solicitada] ${notas}`.trim(),
      },
    });
  }
}
