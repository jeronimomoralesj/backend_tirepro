import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { TireService } from '../tires/tire.service';
import { InventoryBucketsService } from '../tires/inventory-bucket.service';
import { normalizeDimension } from '../common/normalize-dimension';
import type { MotivoFinVida, VidaValue } from '@prisma/client';

// Vida progression used when completing a reencauche cycle. Anything past
// reencauche3 collapses to `fin` because the tire can't be retread further.
const NEXT_VIDA: Record<VidaValue, VidaValue | null> = {
  nueva:       'reencauche1',
  reencauche1: 'reencauche2',
  reencauche2: 'reencauche3',
  reencauche3: 'fin',
  fin:         null,
};

// ── Input shapes ──────────────────────────────────────────────────────────
// Loose shape accepted from the frontend. Each field is optional because the
// analista submits a batch where some rows are well-specified tires and
// others are generic requests. We normalize into PurchaseOrderItem rows.
export interface CreateItemInput {
  tireId?:       string | null;
  tipo:          'nueva' | 'reencauche';
  marca:         string;
  modelo?:       string | null;
  dimension:     string;
  eje?:          string | null;
  cantidad?:     number;
  vehiclePlaca?: string | null;
  urgency?:      string | null;
  notas?:        string | null;
}

export interface CotizacionItemInput {
  itemId:          string;       // row id on purchase_order_items
  precioUnitario:  number;
  disponible:      boolean;
  tiempoEntrega?:  string | null;
  notas?:          string | null;
}

@Injectable()
export class PurchaseOrdersService {
  private readonly logger = new Logger(PurchaseOrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly tires: TireService,
    private readonly buckets: InventoryBucketsService,
  ) {}

  // ── Create ──────────────────────────────────────────────────────────────────

  async createOrder(
    companyId: string,
    distributorId: string,
    items: CreateItemInput[],
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
    if (!Array.isArray(items) || items.length === 0) {
      throw new BadRequestException('items must be a non-empty array');
    }

    const itemRows = items.map((it) => ({
      tireId:       it.tireId      ?? null,
      tipo:         it.tipo,
      marca:        it.marca,
      modelo:       it.modelo      ?? null,
      dimension:    typeof it.dimension === 'string' ? normalizeDimension(it.dimension) : it.dimension,
      eje:          it.eje         ?? null,
      cantidad:     it.cantidad    ?? 1,
      vehiclePlaca: it.vehiclePlaca ?? null,
      urgency:      it.urgency     ?? null,
      notas:        it.notas       ?? null,
    }));

    const order = await this.prisma.purchaseOrder.create({
      data: {
        companyId,
        distributorId,
        totalEstimado: totalEstimado ?? null,
        notas:         notas         ?? null,
        items:         { create: itemRows },
      },
      include: { items: true },
    });

    // Email notification to distributor — same copy as before.
    if (distributor.emailAtencion) {
      const itemCount = order.items.length;
      try {
        await this.email.sendEmail(
          distributor.emailAtencion,
          `Nueva Solicitud de Compra — ${company.name}`,
          this.solicitudEmailHtml(distributor.name, company.name, itemCount),
        );
      } catch (err) {
        this.logger.warn(
          `Failed to send solicitud email to ${distributor.emailAtencion}: ${err.message}`,
        );
      }
    }

    return order;
  }

  // ── Read ────────────────────────────────────────────────────────────────────

  // Detailed include used by both read endpoints. Per-item tire data lets
  // the UI show "Vehicle ABC-123 · P2" for reencauche items without a
  // second round-trip, which is what the fleet's send-to-bucket warning
  // and the dist's reencauche review module both need.
  private readonly ORDER_INCLUDE = {
    items: {
      orderBy: { createdAt: 'asc' as const },
      include: {
        tire: {
          select: {
            id: true,
            placa: true,
            posicion: true,
            vidaActual: true,
            vehicle: { select: { id: true, placa: true } },
          },
        },
      },
    },
  };

  async getOrdersForCompany(companyId: string) {
    return this.prisma.purchaseOrder.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      include: {
        distributor: { select: { id: true, name: true, profileImage: true } },
        ...this.ORDER_INCLUDE,
      },
    });
  }

  async getOrdersForDistributor(distributorId: string) {
    return this.prisma.purchaseOrder.findMany({
      where: { distributorId },
      orderBy: { createdAt: 'desc' },
      include: {
        company: { select: { id: true, name: true, profileImage: true } },
        ...this.ORDER_INCLUDE,
      },
    });
  }

  // ── Cotización ──────────────────────────────────────────────────────────────

  async submitCotizacion(
    orderId: string,
    distributorId: string,
    cotizacion: CotizacionItemInput[],
    totalCotizado: number,
    notas?: string,
  ) {
    const order = await this.prisma.purchaseOrder.findUnique({
      where: { id: orderId },
      include: { items: { select: { id: true } } },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.distributorId !== distributorId) {
      throw new BadRequestException('This order does not belong to your company');
    }
    if (order.status !== 'solicitud_enviada') {
      throw new BadRequestException(`Cannot submit cotización for order in status "${order.status}"`);
    }
    if (!Array.isArray(cotizacion) || cotizacion.length === 0) {
      throw new BadRequestException('cotizacion must be a non-empty array');
    }

    // Reject quote rows that reference items not in this order.
    const orderItemIds = new Set(order.items.map((i) => i.id));
    for (const q of cotizacion) {
      if (!orderItemIds.has(q.itemId)) {
        throw new BadRequestException(`itemId ${q.itemId} does not belong to this order`);
      }
    }

    // Atomic: per-item pricing + order-level status in one transaction.
    const itemUpdates = cotizacion.map((q) =>
      this.prisma.purchaseOrderItem.update({
        where: { id: q.itemId },
        data: {
          precioUnitario:  q.precioUnitario,
          disponible:      q.disponible,
          tiempoEntrega:   q.tiempoEntrega  ?? null,
          cotizacionNotas: q.notas          ?? null,
          status:          'cotizada',
        },
      }),
    );

    const orderUpdate = this.prisma.purchaseOrder.update({
      where: { id: orderId },
      data: {
        status:          'cotizacion_recibida',
        totalCotizado,
        cotizacionFecha: new Date(),
        cotizacionNotas: notas ?? null,
      },
      include: { items: true },
    });

    const [, updatedOrder] = await this.prisma.$transaction([
      ...itemUpdates,
      orderUpdate,
    ]);

    return updatedOrder;
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
        status:     'aceptada',
        resolvedAt: new Date(),
        resolvedBy: companyId,
      },
      include: { items: true },
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

    // Cascade the rejection to every item so the per-row view stays coherent
    // with the order-level status.
    const [, updated] = await this.prisma.$transaction([
      this.prisma.purchaseOrderItem.updateMany({
        where: { purchaseOrderId: orderId },
        data:  { status: 'cancelada', finalizedAt: new Date() },
      }),
      this.prisma.purchaseOrder.update({
        where: { id: orderId },
        data: {
          status:     'rechazada',
          resolvedAt: new Date(),
          resolvedBy: companyId,
          notas: notas ? `${order.notas ?? ''}\n[Rechazo] ${notas}`.trim() : order.notas,
        },
        include: { items: true },
      }),
    ]);
    return updated;
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

    // Clear quote data on items AND the order so the dist can re-quote.
    const [, updated] = await this.prisma.$transaction([
      this.prisma.purchaseOrderItem.updateMany({
        where: { purchaseOrderId: orderId },
        data: {
          status:          'pendiente',
          precioUnitario:  null,
          disponible:      null,
          tiempoEntrega:   null,
          cotizacionNotas: null,
        },
      }),
      this.prisma.purchaseOrder.update({
        where: { id: orderId },
        data: {
          status:          'solicitud_enviada',
          totalCotizado:   null,
          cotizacionFecha: null,
          cotizacionNotas: null,
          notas: `${order.notas ?? ''}\n[Revisión solicitada] ${notas}`.trim(),
        },
        include: { items: true },
      }),
    ]);
    return updated;
  }

  // ── Reencauche lifecycle ────────────────────────────────────────────────────

  // Fleet confirms they're ready to hand over the tires: we move every
  // reencauche item's tire into the company's system-managed Reencauche
  // bucket and flag the items as awaiting distributor approval.
  async sendReencaucheTiresToBucket(orderId: string, companyId: string) {
    const order = await this.prisma.purchaseOrder.findUnique({
      where: { id: orderId },
      include: {
        items: {
          where: { tipo: 'reencauche', tireId: { not: null } },
          include: { tire: { select: { id: true, vidaActual: true } } },
        },
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.companyId !== companyId) {
      throw new BadRequestException('This order does not belong to your company');
    }
    if (order.status !== 'aceptada') {
      throw new BadRequestException(
        `Cannot send to reencauche bucket while order is in status "${order.status}"`,
      );
    }

    const sendable = order.items.filter(
      (i) => i.tireId && i.status === 'cotizada',
    );
    if (sendable.length === 0) {
      throw new BadRequestException(
        'No reencauche items pending to be sent to the bucket',
      );
    }

    const bucket = await this.buckets.getReencaucheBucket(companyId);
    const tireIds = sendable.map((i) => i.tireId!) as string[];

    await this.buckets.bulkMoveTiresToBucket(tireIds, bucket.id, companyId);

    // Snapshot each tire's vida at the moment it enters the cycle — used
    // later by the dist UI to show "pre-reencauche vida" and by analytics.
    await this.prisma.$transaction(
      sendable.map((i) =>
        this.prisma.purchaseOrderItem.update({
          where: { id: i.id },
          data: {
            status:     'en_reencauche_bucket',
            vidaPrevia: i.tire?.vidaActual ?? null,
          },
        }),
      ),
    );

    return this.prisma.purchaseOrder.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
  }

  // Distributor approves a specific reencauche item with an ETA. The tire
  // stays in the reencauche bucket at its current (pre-retread) vida; the
  // vida transition happens at entrega-time to reflect physical reality.
  async approveReencaucheItem(
    itemId: string,
    distributorId: string,
    estimatedDelivery: string,
  ) {
    const item = await this.prisma.purchaseOrderItem.findUnique({
      where:   { id: itemId },
      include: { purchaseOrder: { select: { distributorId: true } } },
    });
    if (!item) throw new NotFoundException('Item not found');
    if (item.purchaseOrder.distributorId !== distributorId) {
      throw new BadRequestException('This item does not belong to your company');
    }
    if (item.tipo !== 'reencauche') {
      throw new BadRequestException('Only reencauche items can be approved this way');
    }
    if (item.status !== 'en_reencauche_bucket') {
      throw new BadRequestException(
        `Cannot approve an item in status "${item.status}"`,
      );
    }
    const eta = new Date(estimatedDelivery);
    if (isNaN(eta.getTime())) {
      throw new BadRequestException('estimatedDelivery is not a valid date');
    }

    return this.prisma.purchaseOrderItem.update({
      where: { id: itemId },
      data: {
        status:            'aprobada',
        estimatedDelivery: eta,
      },
    });
  }

  // Distributor rejects a reencauche item. The tire is routed to
  // fin-de-vida via the existing vida endpoint (so the desechos snapshot
  // is created consistently with manual retire flows). The rejection
  // motivo is stored both on the item and as notasRetiro on the snapshot.
  async rejectReencaucheItem(
    itemId: string,
    distributorId: string,
    motivoRechazo: string,
    desechoData: { causales: string; milimetrosDesechados: number; imageUrls?: string[] },
  ) {
    const item = await this.prisma.purchaseOrderItem.findUnique({
      where:   { id: itemId },
      include: { purchaseOrder: { select: { distributorId: true, id: true } } },
    });
    if (!item) throw new NotFoundException('Item not found');
    if (item.purchaseOrder.distributorId !== distributorId) {
      throw new BadRequestException('This item does not belong to your company');
    }
    if (item.tipo !== 'reencauche') {
      throw new BadRequestException('Only reencauche items can be rejected this way');
    }
    if (item.status !== 'en_reencauche_bucket') {
      throw new BadRequestException(
        `Cannot reject an item in status "${item.status}"`,
      );
    }
    if (!item.tireId) {
      throw new BadRequestException('Reencauche item has no linked tire');
    }
    if (!motivoRechazo?.trim()) {
      throw new BadRequestException('motivoRechazo is required');
    }

    // Route the tire through the standard vida endpoint so TireVidaSnapshot
    // and all cached analytics stay consistent with manual fin-de-vida.
    await this.tires.updateVida(
      item.tireId,
      'fin',
      undefined,             // banda — n/a for fin
      undefined,             // costo — n/a
      undefined,             // profundidadInicial — n/a
      undefined,             // proveedor — n/a
      desechoData,
      undefined,             // bandaMarca
      'reencauche' as MotivoFinVida,
      motivoRechazo.trim(),  // notasRetiro
    );

    const updated = await this.prisma.purchaseOrderItem.update({
      where: { id: itemId },
      data: {
        status:        'rechazada',
        motivoRechazo: motivoRechazo.trim(),
        finalizedAt:   new Date(),
        vidaNueva:     'fin',
      },
    });

    await this.closeOrderIfAllItemsTerminal(item.purchaseOrder.id);
    return updated;
  }

  // Distributor hands tires back after retreading. For each tire being
  // returned, we progress the vida, store retread costs, pull the tire
  // back out of the reencauche bucket, and mark the item entregada. The
  // parent order closes when every item is in a terminal state.
  async entregarReencaucheItems(
    orderId: string,
    distributorId: string,
    deliveries: Array<{
      tireId:             string;
      banda:              string;
      bandaMarca?:        string | null;
      costo:              number;
      profundidadInicial: number;
      proveedor?:         string | null;
    }>,
  ) {
    const order = await this.prisma.purchaseOrder.findUnique({
      where:   { id: orderId },
      include: {
        items: { include: { tire: { select: { id: true, vidaActual: true, companyId: true } } } },
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.distributorId !== distributorId) {
      throw new BadRequestException('This order does not belong to your company');
    }
    if (!Array.isArray(deliveries) || deliveries.length === 0) {
      throw new BadRequestException('deliveries must be a non-empty array');
    }

    // Index approved reencauche items by tireId for fast lookup + validation.
    const approvedByTireId = new Map(
      order.items
        .filter((i) => i.tipo === 'reencauche' && i.status === 'aprobada' && i.tireId)
        .map((i) => [i.tireId as string, i] as const),
    );

    for (const d of deliveries) {
      const item = approvedByTireId.get(d.tireId);
      if (!item || !item.tire) {
        throw new BadRequestException(`Tire ${d.tireId} is not an approved reencauche item on this order`);
      }
      const next = NEXT_VIDA[item.tire.vidaActual];
      if (!next || next === 'fin') {
        throw new BadRequestException(
          `Tire ${d.tireId} at vida "${item.tire.vidaActual}" cannot be retread further`,
        );
      }

      // Vida progression — writes the TireEvento + TireVidaSnapshot.
      await this.tires.updateVida(
        d.tireId,
        next,
        d.banda,
        d.costo,
        d.profundidadInicial,
        d.proveedor ?? undefined,
        undefined,
        d.bandaMarca ?? undefined,
      );

      // Tire out of reencauche bucket → implicit Disponible (null bucket).
      await this.buckets.bulkMoveTiresToBucket([d.tireId], null, order.companyId);

      // Mark the item delivered.
      await this.prisma.purchaseOrderItem.update({
        where: { id: item.id },
        data: {
          status:      'entregada',
          vidaNueva:   next,
          finalizedAt: new Date(),
        },
      });
    }

    await this.closeOrderIfAllItemsTerminal(orderId);

    return this.prisma.purchaseOrder.findUnique({
      where:   { id: orderId },
      include: { items: true },
    });
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  // Flip the parent order to `completada` once every item has reached a
  // terminal state (entregada/rechazada/completada/cancelada). Safe to call
  // after any per-item transition; a no-op if items are still in flight.
  private async closeOrderIfAllItemsTerminal(orderId: string): Promise<void> {
    const TERMINAL: string[] = ['entregada', 'rechazada', 'completada', 'cancelada'];
    const pendingCount = await this.prisma.purchaseOrderItem.count({
      where: {
        purchaseOrderId: orderId,
        status: { notIn: TERMINAL as any },
      },
    });
    if (pendingCount > 0) return;

    const order = await this.prisma.purchaseOrder.findUnique({
      where: { id: orderId },
      select: { status: true },
    });
    if (!order || order.status === 'completada' || order.status === 'rechazada') return;

    await this.prisma.purchaseOrder.update({
      where: { id: orderId },
      data:  { status: 'completada', resolvedAt: new Date() },
    });
  }


  private solicitudEmailHtml(distributorName: string, companyName: string, itemCount: number): string {
    return `
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
              <p style="font-size: 16px; margin-bottom: 20px;">Hola ${distributorName},</p>
              <p style="font-size: 16px; margin-bottom: 20px;">
                <strong>${companyName}</strong> ha enviado una solicitud de compra de
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
    `;
  }
}
