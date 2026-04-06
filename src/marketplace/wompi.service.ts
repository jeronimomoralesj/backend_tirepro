import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as crypto from 'crypto';

@Injectable()
export class WompiService {
  private readonly logger = new Logger(WompiService.name);
  private readonly baseUrl: string;

  constructor(private readonly prisma: PrismaService) {
    // Use sandbox in dev, production in prod
    this.baseUrl = process.env.WOMPI_ENV === 'production'
      ? 'https://production.wompi.co/v1'
      : 'https://sandbox.wompi.co/v1';
  }

  /**
   * Generate the integrity signature for the Wompi widget.
   * Hash = SHA256(reference + amountInCents + currency + integritySecret)
   */
  generateIntegritySignature(reference: string, amountInCents: number, currency = 'COP'): string {
    const secret = process.env.WOMPI_INTEGRITY_SECRET;
    if (!secret) throw new Error('WOMPI_INTEGRITY_SECRET not configured');
    const data = `${reference}${amountInCents}${currency}${secret}`;
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Verify webhook event signature from Wompi.
   * Wompi sends a checksum in the header that we verify with our events secret.
   */
  verifyWebhookSignature(body: any): boolean {
    const secret = process.env.WOMPI_EVENTS_SECRET;
    if (!secret) {
      this.logger.warn('WOMPI_EVENTS_SECRET not configured, skipping verification');
      return true;
    }

    const properties: string[] = body.signature?.properties ?? [];
    const checksum: string = body.signature?.checksum ?? '';
    if (!properties.length || !checksum) return false;

    // Resolve each dot-path property from the payload
    const values = properties.map((prop: string) =>
      prop.split('.').reduce((obj: any, key: string) => obj?.[key], body),
    );

    const concatenated = values.join('') + (body.timestamp ?? '') + secret;
    const computed = crypto.createHash('sha256').update(concatenated).digest('hex');

    try {
      return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(checksum));
    } catch {
      return false;
    }
  }

  /**
   * Check transaction status directly with Wompi API
   */
  async getTransactionStatus(transactionId: string): Promise<any> {
    try {
      const res = await fetch(`${this.baseUrl}/transactions/${transactionId}`, {
        headers: { 'Authorization': `Bearer ${process.env.WOMPI_PRIVATE_KEY}` },
      });
      if (!res.ok) return null;
      return res.json();
    } catch (err) {
      this.logger.error(`Failed to check transaction ${transactionId}: ${err}`);
      return null;
    }
  }

  /**
   * Handle a Wompi webhook event (transaction.updated)
   */
  async handleWebhookEvent(body: any): Promise<{ ok: boolean; message: string }> {
    if (!this.verifyWebhookSignature(body)) {
      this.logger.warn('Invalid Wompi webhook signature');
    }

    const event = body.event;
    const data = body.data?.transaction;

    if (!data) return { ok: false, message: 'No transaction data' };

    const reference = data.reference; // Our order ID
    const status = data.status; // APPROVED, DECLINED, VOIDED, ERROR
    const transactionId = data.id;

    this.logger.log(`Wompi webhook: ${event} — ref=${reference} status=${status} txn=${transactionId}`);

    if (!reference) return { ok: false, message: 'No reference' };

    // Find the order by reference (we use orderId as reference)
    const order = await this.prisma.marketplaceOrder.findUnique({
      where: { id: reference },
    });

    if (!order) {
      this.logger.warn(`Order not found for reference: ${reference}`);
      return { ok: false, message: 'Order not found' };
    }

    // Update order based on payment status
    if (status === 'APPROVED') {
      await this.prisma.marketplaceOrder.update({
        where: { id: reference },
        data: {
          status: 'confirmado',
          paymentId: transactionId,
          paymentStatus: 'approved',
        },
      });
      this.logger.log(`Order ${reference} payment approved`);
    } else if (status === 'DECLINED' || status === 'ERROR' || status === 'VOIDED') {
      await this.prisma.marketplaceOrder.update({
        where: { id: reference },
        data: {
          paymentStatus: status.toLowerCase(),
        },
      });
      this.logger.log(`Order ${reference} payment ${status}`);
    }

    return { ok: true, message: `Processed ${status}` };
  }
}
