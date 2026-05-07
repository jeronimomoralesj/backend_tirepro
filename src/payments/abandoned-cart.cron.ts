// =============================================================================
// Abandoned-cart recovery cron.
//
// Hourly job that finds Bold/Wompi `pending` payments that:
//   - Are between 24h and 7 days old (window — buyer is past the
//     "still in flow" period but the original Bold checkout link is
//     still valid for 7 days).
//   - Have NOT already received a recovery email
//     (recoveryEmailSentAt IS NULL).
//
// For each, we send the buyer a one-shot reminder email with a CTA
// back to the order tracking page. The tracking page already shows
// the original Bold checkout link via its "Pago pendiente" banner,
// so we don't generate a fresh checkout — re-using the original link
// keeps the reference + signature consistent across the row's
// lifetime and avoids creating duplicate Payment rows.
//
// Idempotency: setting `recoveryEmailSentAt = now()` is the gate.
// Even if the cron double-fires we never spam a buyer twice.
//
// Why hourly: tests show recovery emails work best when sent within
// 24-30h of the abandoned action. Daily runs would miss the
// 24h-after-cart sweet spot for buyers who abandoned just after the
// previous run; hourly catches the cohort within a tight window.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';

// Window edges. RECOVER_AFTER_MS is how long we wait before nudging;
// RECOVER_BEFORE_MS is the cutoff after which the original Bold
// checkout link expires and a recovery email becomes useless.
const RECOVER_AFTER_MS  = 24 * 60 * 60 * 1000;       // 24h
const RECOVER_BEFORE_MS = 7  * 24 * 60 * 60 * 1000;  // 7d
const BATCH_LIMIT = 50; // safety cap per run

@Injectable()
export class AbandonedCartCron {
  private readonly logger = new Logger(AbandonedCartCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email:  EmailService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'abandoned-cart-recovery', timeZone: 'America/Bogota' })
  async sweepAbandonedCarts() {
    const now = Date.now();
    const earliestCreatedAt = new Date(now - RECOVER_BEFORE_MS);
    const latestCreatedAt   = new Date(now - RECOVER_AFTER_MS);

    // Find pending payments inside the recovery window. We pull the
    // first order on each Payment to recover the buyer + listing
    // metadata for the email — multi-item carts share one Payment so
    // referring to "tu pedido de {marca} {modelo}" with the first
    // item is acceptable (and the email goes to one buyerEmail
    // anyway).
    const payments = await this.prisma.payment.findMany({
      where: {
        status: 'pending',
        recoveryEmailSentAt: null,
        createdAt: {
          gte: earliestCreatedAt,
          lt:  latestCreatedAt,
        },
      },
      orderBy: { createdAt: 'asc' },
      take: BATCH_LIMIT,
      include: {
        orders: {
          include: {
            listing:     { select: { marca: true, modelo: true, dimension: true, imageUrls: true, coverIndex: true } },
            distributor: { select: { name: true } },
          },
        },
      },
    });

    if (payments.length === 0) {
      this.logger.debug('No abandoned carts in the 24h-7d window — nothing to nudge.');
      return;
    }

    let sent = 0;
    let failed = 0;

    for (const payment of payments) {
      const order = payment.orders[0];
      if (!order) {
        // Defensive: a payment with zero orders shouldn't exist (we
        // create them in the same transaction in createBoldCheckout)
        // but if it does, mark recoveryEmailSentAt so we don't keep
        // hitting it forever.
        await this.prisma.payment.update({
          where: { id: payment.id },
          data:  { recoveryEmailSentAt: new Date() },
        });
        continue;
      }

      const imgs = Array.isArray(order.listing.imageUrls)
        ? (order.listing.imageUrls as unknown[]).filter((u): u is string => typeof u === 'string')
        : [];
      const cover = imgs[order.listing.coverIndex ?? 0] ?? imgs[0] ?? null;

      try {
        await this.email.sendCartRecovery({
          buyerEmail:      order.buyerEmail,
          buyerName:       order.buyerName,
          orderId:         order.id,
          distributorName: order.distributor?.name ?? 'el distribuidor',
          listing: {
            marca:     order.listing.marca,
            modelo:    order.listing.modelo,
            dimension: order.listing.dimension,
            imageUrl:  cover,
          },
          quantity: order.quantity,
          totalCop: order.totalCop,
        });

        await this.prisma.payment.update({
          where: { id: payment.id },
          data:  { recoveryEmailSentAt: new Date() },
        });
        sent += 1;
      } catch (err) {
        failed += 1;
        this.logger.warn(
          `Recovery email failed for payment ${payment.id} (buyer: ${order.buyerEmail}): ${err}`,
        );
        // Don't mark recoveryEmailSentAt on transient failures — a
        // future run will retry. SMTP outages are rare and short, so
        // capping retries via the BATCH_LIMIT + 1h cadence is fine.
      }
    }

    this.logger.log(
      `Abandoned-cart sweep: ${sent} email${sent === 1 ? '' : 's'} sent, ` +
      `${failed} failed (out of ${payments.length} candidates).`,
    );
  }
}
