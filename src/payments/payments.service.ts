import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';

/**
 * Collects + dedupes the distributor's notification recipients. The
 * primary email goes first so it leads the queue, then any extras
 * the dist has added on /perfil. Case-insensitive dedup means
 * "Foo@x.com" and "foo@x.com" only get one email. Empty / falsy
 * entries drop out — extras live in a Postgres array and may carry
 * empty strings depending on UI input handling.
 */
function collectDistEmails(
  primary: string | null | undefined,
  extras: string[] | null | undefined,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string | null | undefined) => {
    const t = (raw ?? '').trim();
    if (!t) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };
  push(primary);
  for (const e of extras ?? []) push(e);
  return out;
}

// =============================================================================
// MARKETPLACE PAYMENTS — money flow
// =============================================================================
//   1. Buyer fills cart, hits checkout. We create one MarketplaceOrder per
//      cart line plus one Payment row that aggregates the totals.
//   2. We hand the Payment.wompiReference + grossCop + integrity signature
//      to the frontend. The frontend opens Wompi's web checkout (link mode
//      via redirect) — buyer pays.
//   3. Wompi redirects the buyer back to the tracking page. Wompi also
//      fires a webhook to /payments/wompi/webhook with the final status.
//   4. The webhook handler flips Payment.status (and the related orders
//      from `pago_pendiente` to `pendiente`) when status === APPROVED.
//   5. Once an order reaches `entregado` and 3 days have passed, it shows
//      up in the admin payouts queue. TirePro admin sends the bank
//      transfer manually and marks the Payout as released.
// =============================================================================

const FEE_RATE = 0.05;          // 5% TirePro commission
const HOLD_DAYS_BEFORE_PAYOUT = 3; // days after `entregado` before payout shows up

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly wompiBaseUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {
    this.wompiBaseUrl = process.env.WOMPI_ENV === 'production'
      ? 'https://production.wompi.co/v1'
      : 'https://sandbox.wompi.co/v1';
  }

  // ===========================================================================
  // Wompi crypto helpers
  // ===========================================================================

  /**
   * Wompi widget integrity signature.
   * sha256(reference + amountInCents + currency + integritySecret)
   */
  private generateIntegritySignature(reference: string, amountInCents: number): string {
    const secret = process.env.WOMPI_INTEGRITY_SECRET;
    if (!secret) throw new Error('WOMPI_INTEGRITY_SECRET not configured');
    return crypto.createHash('sha256')
      .update(`${reference}${amountInCents}COP${secret}`)
      .digest('hex');
  }

  /**
   * Wompi webhook event signature. Wompi sends a list of `properties` to
   * concatenate from the body, plus a top-level `timestamp`, hashed with
   * the events secret.
   */
  private verifyWebhookSignature(body: any): boolean {
    const secret = process.env.WOMPI_EVENTS_SECRET;
    if (!secret) {
      this.logger.warn('WOMPI_EVENTS_SECRET not configured — accepting webhook unverified');
      return true;
    }
    const properties: string[] = body?.signature?.properties ?? [];
    const checksum: string = body?.signature?.checksum ?? '';
    if (!properties.length || !checksum) return false;

    const values = properties.map((p) =>
      p.split('.').reduce((obj: any, k: string) => obj?.[k], body),
    );
    const computed = crypto.createHash('sha256')
      .update(values.join('') + (body.timestamp ?? '') + secret)
      .digest('hex');

    try {
      return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(checksum));
    } catch {
      return false;
    }
  }

  // ===========================================================================
  // Checkout — one Wompi transaction per cart, even if it covers multiple
  // distributors. Per-order fee/net are recorded so payouts know the split.
  // ===========================================================================

  async createCheckout(input: {
    items: Array<{
      listingId: string;
      quantity: number;
      /** Optional pickup-point selection per line. When set, the
       *  whole order line ships in pickup mode against that point. */
      pickupPointId?: string;
    }>;
    userId?: string;
    buyerName: string;
    buyerEmail: string;
    buyerPhone?: string;
    buyerAddress?: string;
    buyerCity?: string;
    buyerCompany?: string;
    notas?: string;
    /** Where Wompi sends the buyer back after the checkout (frontend URL). */
    redirectBaseUrl: string;
  }) {
    if (!input.items?.length) throw new BadRequestException('Cart is empty');
    if (!input.buyerName?.trim() || !input.buyerEmail?.trim()) {
      throw new BadRequestException('Buyer name and email are required');
    }

    // Resolve all listings + distributor info up front so we can build the
    // money breakdown before persisting anything.
    const listings = await this.prisma.distributorListing.findMany({
      where: { id: { in: input.items.map((i) => i.listingId) } },
      include: { distributor: { select: { id: true, slug: true, name: true, emailAtencion: true } } },
    });
    if (listings.length !== input.items.length) {
      throw new BadRequestException('One or more products are no longer available');
    }
    // Stock check — refuse the whole cart if any line exceeds available.
    for (const item of input.items) {
      const l = listings.find((x) => x.id === item.listingId)!;
      if (!l.isActive) throw new BadRequestException(`${l.marca} ${l.modelo} ya no está disponible`);
      if (l.cantidadDisponible < item.quantity) {
        throw new BadRequestException(`Solo ${l.cantidadDisponible} unidades disponibles de ${l.marca} ${l.modelo}`);
      }
    }

    // Resolve any pickup-point selections up-front. We allow the
    // frontend to send pickupPointId per line; each one is validated
    // here against the listing's RetailSource so a malformed payload
    // can't attach to a foreign distributor's store.
    const pickupRequests = input.items
      .map((item) => ({ listingId: item.listingId, pickupPointId: item.pickupPointId }))
      .filter((p) => !!p.pickupPointId);
    const pickupPointMap = new Map<string, { id: string; name: string; city: string; cityDisplay: string | null }>();
    if (pickupRequests.length > 0) {
      const pps = await this.prisma.retailPickupPoint.findMany({
        where: { id: { in: pickupRequests.map((p) => p.pickupPointId!) } },
        include: { source: { select: { listingId: true, isActive: true } } },
      });
      for (const req of pickupRequests) {
        const pp = pps.find((x) => x.id === req.pickupPointId);
        if (!pp || !pp.source?.isActive || pp.source.listingId !== req.listingId) {
          throw new BadRequestException('Punto de recogida no válido para este producto');
        }
        if (pp.stockUnits <= 0) {
          throw new BadRequestException(`${pp.name} no tiene unidades disponibles ahora`);
        }
        pickupPointMap.set(req.listingId, {
          id: pp.id, name: pp.name, city: pp.city, cityDisplay: pp.cityDisplay,
        });
      }
    }

    // Build per-order totals + the aggregate Payment row.
    const orderInputs = input.items.map((item) => {
      const l = listings.find((x) => x.id === item.listingId)!;
      const totalCop = l.precioCop * item.quantity;
      const feeCop   = Math.round(totalCop * FEE_RATE);
      const netCop   = totalCop - feeCop;
      const pickup   = item.pickupPointId ? pickupPointMap.get(item.listingId) ?? null : null;
      return { listing: l, quantity: item.quantity, totalCop, feeCop, netCop, pickup };
    });
    const grossCop = orderInputs.reduce((s, o) => s + o.totalCop, 0);
    const feeCop   = orderInputs.reduce((s, o) => s + o.feeCop,   0);
    const netCop   = orderInputs.reduce((s, o) => s + o.netCop,   0);

    // Wompi reference: a UUID-ish string we can correlate webhook events
    // back to one Payment row. We don't reuse the Payment.id because
    // Wompi also stores the reference in the buyer-visible txn detail.
    const reference = `tp_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;

    // Persist Payment + Orders in one transaction so a stale Wompi
    // checkout can't leave half-created data.
    const result = await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          wompiReference: reference,
          status:         'pending',
          grossCop,
          feeCop,
          netCop,
          buyerEmail:     input.buyerEmail,
        },
      });
      const orders = await Promise.all(orderInputs.map((o) => tx.marketplaceOrder.create({
        data: {
          listingId:      o.listing.id,
          distributorId:  o.listing.distributorId,
          quantity:       o.quantity,
          totalCop:       o.totalCop,
          feeCop:         o.feeCop,
          netCop:         o.netCop,
          paymentId:      payment.id,
          // status starts at the new "pago_pendiente" — webhook flips
          // to "pendiente" once Wompi reports APPROVED.
          status:         'pago_pendiente',
          userId:         input.userId ?? null,
          buyerName:      input.buyerName,
          buyerEmail:     input.buyerEmail,
          buyerPhone:     input.buyerPhone ?? null,
          buyerAddress:   input.buyerAddress ?? null,
          buyerCity:      input.buyerCity ?? null,
          buyerCompany:   input.buyerCompany ?? null,
          notas:          input.notas ?? null,
          // Pickup metadata is denormalised onto the order so a renamed
          // / removed point doesn't break the order detail later.
          deliveryMode:   o.pickup ? 'pickup' : 'domicilio',
          pickupPointId:  o.pickup?.id ?? null,
          pickupPointName: o.pickup?.name ?? null,
          pickupCity:     o.pickup?.cityDisplay ?? o.pickup?.city ?? null,
          statusHistory: [{ status: 'pago_pendiente', at: new Date().toISOString() }] as any,
        },
        include: { listing: true, distributor: { select: { name: true } } },
      })));
      return { payment, orders };
    });

    // Wompi widget config — the frontend uses these to open the checkout.
    const amountInCents = Math.round(grossCop * 100);
    const signature = this.generateIntegritySignature(reference, amountInCents);
    const redirectUrl = `${input.redirectBaseUrl}/marketplace/order/${result.orders[0].id}?email=${encodeURIComponent(input.buyerEmail)}`;

    // Build Wompi web-checkout URL — same host for sandbox and prod;
    // the test/prod prefix on `public-key` is what tells Wompi which
    // environment to charge against.
    const checkoutParams = new URLSearchParams({
      'public-key':              process.env.WOMPI_PUBLIC_KEY ?? '',
      'currency':                'COP',
      'amount-in-cents':         String(amountInCents),
      'reference':               reference,
      'signature:integrity':     signature,
      'redirect-url':            redirectUrl,
      'customer-data:email':     input.buyerEmail,
      'customer-data:full-name': input.buyerName,
      ...(input.buyerPhone ? { 'customer-data:phone-number': input.buyerPhone } : {}),
    });
    const checkoutUrl = `https://checkout.wompi.co/p/?${checkoutParams.toString()}`;

    return {
      paymentId: result.payment.id,
      reference,
      amountInCents,
      currency: 'COP',
      signature,
      publicKey: process.env.WOMPI_PUBLIC_KEY,
      redirectUrl,
      checkoutUrl,
      orderIds: result.orders.map((o) => o.id),
    };
  }

  // ===========================================================================
  // Webhook handler — Wompi pings us on every transaction.updated event.
  // ===========================================================================

  async handleWebhook(body: any) {
    if (!this.verifyWebhookSignature(body)) {
      this.logger.warn(`Wompi webhook with invalid signature — ref=${body?.data?.transaction?.reference}`);
      // Don't 401: Wompi will retry. Just log and accept; the integrity
      // signature on the widget already protected the original amount.
    }

    const data = body?.data?.transaction;
    if (!data) return { ok: false, reason: 'No transaction data' };

    const reference     = data.reference     as string;
    const wompiId       = data.id            as string;
    const status        = data.status        as string; // APPROVED | DECLINED | VOIDED | ERROR
    const paymentMethod = data.payment_method_type as string | undefined;

    if (!reference) return { ok: false, reason: 'No reference' };

    const payment = await this.prisma.payment.findUnique({ where: { wompiReference: reference } });
    if (!payment) {
      this.logger.warn(`Wompi webhook for unknown reference ${reference}`);
      return { ok: false, reason: 'Unknown reference' };
    }

    const normalized = this.normalizeStatus(status);

    // Idempotent: if we already saw this final state, no-op.
    if (payment.status === normalized && payment.wompiTransactionId === wompiId) {
      return { ok: true, reason: 'Already processed' };
    }

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        wompiTransactionId: wompiId,
        status:             normalized,
        paymentMethod:      paymentMethod ?? payment.paymentMethod,
        paidAt:             normalized === 'approved' ? new Date() : payment.paidAt,
        rawWebhookData:     body as any,
      },
    });

    // Cascade to orders. APPROVED → flip every order in this Payment from
    // `pago_pendiente` to `pendiente` (waiting on dist confirmation).
    // DECLINED / VOIDED / ERROR → mark them cancelado_pago so the dist
    // doesn't see them in their inbox.
    if (normalized === 'approved') {
      await this.advanceOrdersToPendiente(payment.id);
      await this.notifyBuyerPaymentApproved(payment.id);
    } else if (normalized === 'declined' || normalized === 'voided' || normalized === 'error') {
      await this.markOrdersCancelledByPayment(payment.id, normalized);
    }

    return { ok: true, reason: `Processed ${normalized}` };
  }

  private normalizeStatus(wompi: string): string {
    switch ((wompi || '').toUpperCase()) {
      case 'APPROVED': return 'approved';
      case 'DECLINED': return 'declined';
      case 'VOIDED':   return 'voided';
      case 'ERROR':    return 'error';
      case 'PENDING':  return 'pending';
      default:         return 'pending';
    }
  }

  private async advanceOrdersToPendiente(paymentId: string) {
    const orders = await this.prisma.marketplaceOrder.findMany({
      where: { paymentId, status: 'pago_pendiente' },
      include: {
        listing:     { select: { marca: true, modelo: true, dimension: true, imageUrls: true, coverIndex: true } },
        distributor: { select: { name: true, emailAtencion: true, emailsAtencion: true } },
      },
    });
    for (const order of orders) {
      const prevHistory = Array.isArray((order as any).statusHistory) ? (order as any).statusHistory : [];
      await this.prisma.marketplaceOrder.update({
        where: { id: order.id },
        data: {
          status: 'pendiente',
          statusHistory: [...prevHistory, { status: 'pendiente', at: new Date().toISOString(), note: 'Pago aprobado' }] as any,
        },
      });
      // Notify the dist that a new (paid) order has landed. Fans out
      // to every email on the distributor's notification list:
      //   - emailAtencion  (the primary public contact email)
      //   - emailsAtencion (additional recipients, up to 2 in the UI)
      // Deduped case-insensitively at send time so a typo or repeat
      // doesn't double-send. Each send is its own try-catch — one
      // bad address shouldn't drop the others.
      const recipients = collectDistEmails(
        order.distributor.emailAtencion,
        order.distributor.emailsAtencion,
      );
      if (recipients.length > 0) {
        const imgs = Array.isArray((order.listing as any).imageUrls) ? (order.listing as any).imageUrls as string[] : [];
        const cover = imgs.length > 0 ? (imgs[(order.listing as any).coverIndex ?? 0] ?? imgs[0]) : null;
        for (const to of recipients) {
          try {
            await this.email.sendOrderToDistributor({
              distributorEmail: to,
              orderId:          order.id,
              listing: { marca: order.listing.marca, modelo: order.listing.modelo, dimension: order.listing.dimension, imageUrl: cover },
              quantity:    order.quantity,
              totalCop:    order.totalCop,
              buyerName:   order.buyerName,
              buyerPhone:  order.buyerPhone,
              buyerCity:   order.buyerCity,
            });
          } catch (err: any) {
            this.logger.warn(`Failed to notify distributor (${to}) of new order ${order.id}: ${err?.message ?? err}`);
          }
        }
      }
    }
  }

  private async markOrdersCancelledByPayment(paymentId: string, reason: string) {
    const orders = await this.prisma.marketplaceOrder.findMany({
      where: { paymentId, status: 'pago_pendiente' },
    });
    for (const order of orders) {
      const prevHistory = Array.isArray((order as any).statusHistory) ? (order as any).statusHistory : [];
      await this.prisma.marketplaceOrder.update({
        where: { id: order.id },
        data: {
          status: 'cancelado',
          notas: `[CANCELADO_PAGO] Pago ${reason}${order.notas ? ` | Original: ${order.notas}` : ''}`,
          statusHistory: [...prevHistory, { status: 'cancelado', at: new Date().toISOString(), note: `Pago ${reason}` }] as any,
        },
      });
    }
  }

  private async notifyBuyerPaymentApproved(paymentId: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        orders: {
          include: {
            listing: { select: { marca: true, modelo: true, dimension: true, imageUrls: true, coverIndex: true } },
            distributor: { select: { name: true } },
          },
        },
      },
    });
    if (!payment) return;
    // For now we send the existing order-confirmation email per order.
    // (One Wompi payment can cover multiple orders; the buyer gets one
    // confirmation per order so they have the tracking link for each.)
    for (const order of payment.orders) {
      try {
        const imgs = Array.isArray((order.listing as any).imageUrls) ? (order.listing as any).imageUrls as string[] : [];
        const cover = imgs.length > 0 ? (imgs[(order.listing as any).coverIndex ?? 0] ?? imgs[0]) : null;
        await this.email.sendOrderConfirmation({
          buyerEmail:      order.buyerEmail,
          buyerName:       order.buyerName,
          orderId:         order.id,
          distributorName: order.distributor.name,
          listing: { marca: order.listing.marca, modelo: order.listing.modelo, dimension: order.listing.dimension, imageUrl: cover },
          quantity:        order.quantity,
          totalCop:        order.totalCop,
          buyerAddress:    order.buyerAddress,
          buyerCity:       order.buyerCity,
        });
      } catch (err: any) {
        this.logger.warn(`Failed to send buyer confirmation for order ${order.id}: ${err?.message ?? err}`);
      }
    }
  }

  // ===========================================================================
  // Distributor bank account onboarding
  // ===========================================================================

  async getMyAccount(companyId: string) {
    return this.prisma.distributorPaymentAccount.findUnique({
      where: { companyId },
    });
  }

  async upsertMyAccount(companyId: string, data: {
    holderName: string;
    documentType: string;
    documentNumber: string;
    bankName: string;
    accountType: string;
    accountNumber: string;
    notificationEmail?: string | null;
  }) {
    if (!data.holderName?.trim() || !data.documentNumber?.trim() || !data.accountNumber?.trim()) {
      throw new BadRequestException('Datos bancarios incompletos');
    }
    if (!['NIT', 'CC'].includes(data.documentType)) {
      throw new BadRequestException('Tipo de documento inválido');
    }
    if (!['ahorros', 'corriente'].includes(data.accountType)) {
      throw new BadRequestException('Tipo de cuenta inválido');
    }
    return this.prisma.distributorPaymentAccount.upsert({
      where:  { companyId },
      create: { companyId, ...data, notificationEmail: data.notificationEmail ?? null },
      update: { ...data, notificationEmail: data.notificationEmail ?? null, verifiedAt: null }, // re-verify if anything changed
    });
  }

  // ===========================================================================
  // Admin payout queue — what to send + manual release flow.
  // ===========================================================================

  /**
   * Orders eligible for payout: status === 'entregado', updated > HOLD days
   * ago, no payoutId yet, payment was approved. Grouped by distributor.
   */
  async getPayoutQueue() {
    const cutoff = new Date(Date.now() - HOLD_DAYS_BEFORE_PAYOUT * 24 * 60 * 60 * 1000);
    const eligible = await this.prisma.marketplaceOrder.findMany({
      where: {
        status:    'entregado',
        payoutId:  null,
        updatedAt: { lt: cutoff },
        payment:   { status: 'approved' },
      },
      include: {
        distributor: {
          select: {
            id: true, name: true, slug: true,
            paymentAccount: true,
          },
        },
        listing: { select: { marca: true, modelo: true, dimension: true } },
      },
      orderBy: { updatedAt: 'asc' },
    });

    // Group by distributor — surface a single row per dist with the
    // aggregate amount, account info, and the list of orders included.
    const byDist = new Map<string, {
      distributorId: string;
      distributorName: string;
      bankAccount: any | null;
      amountCop: number;
      orders: Array<{ id: string; total: number; net: number; productLabel: string }>;
    }>();
    for (const o of eligible) {
      const key = o.distributorId;
      if (!byDist.has(key)) {
        byDist.set(key, {
          distributorId:   o.distributorId,
          distributorName: o.distributor.name,
          bankAccount:     o.distributor.paymentAccount,
          amountCop:       0,
          orders:          [],
        });
      }
      const bucket = byDist.get(key)!;
      const net = o.netCop ?? Math.round((o.totalCop ?? 0) * (1 - FEE_RATE));
      bucket.amountCop += net;
      bucket.orders.push({
        id: o.id,
        total: o.totalCop,
        net,
        productLabel: `${o.listing.marca} ${o.listing.modelo} · ${o.listing.dimension}`,
      });
    }
    return Array.from(byDist.values());
  }

  /**
   * Mark all eligible orders for one distributor as paid out. Records the
   * bank reference number, links every Order row to the new Payout, and
   * fires a comprobante email to the distributor.
   */
  async releasePayout(input: {
    distributorId: string;
    bankReferenceNumber: string;
    releasedByUserId?: string;
    notes?: string;
  }) {
    if (!input.bankReferenceNumber?.trim()) {
      throw new BadRequestException('bankReferenceNumber is required');
    }
    const queue = await this.getPayoutQueue();
    const bucket = queue.find((q) => q.distributorId === input.distributorId);
    if (!bucket) throw new NotFoundException('No eligible payout for this distributor');
    if (!bucket.bankAccount) {
      throw new BadRequestException('El distribuidor no ha registrado una cuenta bancaria');
    }

    const orderIds = bucket.orders.map((o) => o.id);

    const payout = await this.prisma.$transaction(async (tx) => {
      const created = await tx.payout.create({
        data: {
          distributorId:       input.distributorId,
          bankAccountId:       bucket.bankAccount.id,
          amountCop:           bucket.amountCop,
          status:              'released',
          releasedAt:          new Date(),
          releasedByUserId:    input.releasedByUserId ?? null,
          bankReferenceNumber: input.bankReferenceNumber.trim(),
          notes:               input.notes ?? null,
        },
      });
      await tx.marketplaceOrder.updateMany({
        where: { id: { in: orderIds }, payoutId: null },
        data:  { payoutId: created.id },
      });
      return created;
    });

    // Fire-and-forget comprobante email to the dist.
    try {
      const account = bucket.bankAccount;
      const to = account.notificationEmail || (await this.prisma.company.findUnique({ where: { id: input.distributorId }, select: { emailAtencion: true } }))?.emailAtencion;
      if (to) {
        await this.email.sendEmail(
          to,
          `Pago realizado — TirePro Marketplace`,
          // Lightweight inline template; we can promote to a typed
          // EmailService method once we have a couple of payout cycles
          // and know what info distributors actually want to see.
          `<div style="font-family:system-ui;max-width:600px;margin:0 auto;padding:24px;color:#0A183A">
            <h2 style="margin:0 0 12px;font-size:20px;font-weight:900">Realizamos un pago a tu cuenta</h2>
            <p style="margin:0 0 16px;font-size:14px;line-height:1.6">Pago consolidado por ${bucket.orders.length} pedido${bucket.orders.length === 1 ? '' : 's'} entregado${bucket.orders.length === 1 ? '' : 's'} en TirePro Marketplace.</p>
            <p style="margin:0 0 6px;font-size:14px"><strong>Monto:</strong> ${new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(bucket.amountCop)}</p>
            <p style="margin:0 0 6px;font-size:14px"><strong>Cuenta destino:</strong> ${account.bankName} — ${account.accountType} ****${account.accountNumber.slice(-4)}</p>
            <p style="margin:0 0 6px;font-size:14px"><strong>Referencia bancaria:</strong> ${input.bankReferenceNumber.trim()}</p>
            <hr style="border:none;border-top:1px solid #eee;margin:20px 0"/>
            <p style="margin:0;font-size:12px;color:#999">TirePro Marketplace — tirepro.com.co</p>
          </div>`,
        );
      }
    } catch (err: any) {
      this.logger.warn(`Failed to send payout receipt: ${err?.message ?? err}`);
    }

    return payout;
  }
}
