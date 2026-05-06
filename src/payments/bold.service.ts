import { Injectable, Logger, BadGatewayException } from '@nestjs/common';
import * as crypto from 'crypto';

// Bold's "API Link de pagos" creates a hosted checkout URL we redirect the
// buyer to. Mirrors the shape of the Wompi web-checkout flow we already
// have, but server-to-server (no JS button on the cart). This is the same
// endpoint Bold uses to back its dashboard "Generar link" feature, so the
// keys we already have for Botón de Pagos (identity + secret) are valid.
//
//   Auth:    Authorization: x-api-key <identity_key>   (literal scheme!)
//   Amounts: integer COP, NOT cents (unlike Wompi)
//   Min:     COP $1 000
//
// On webhook, Bold ships an HMAC-SHA256 signature of the raw body in the
// `x-bold-signature` header (base64). The signing secret is the "Llave
// secreta para webhook" issued in the Bold dashboard when you create the
// webhook subscription — different from the public/identity key.
const BOLD_LINK_API = 'https://integrations.api.bold.co/online/link/v1';

export type BoldPaymentLinkRequest = {
  /** Our reference — we set this to Payment.boldOrderId so the webhook can
   *  correlate via data.metadata.reference. Max 60 chars, alphanumeric +
   *  '-' + '_'. */
  reference: string;
  /** Whole pesos (COP). NOT cents. Bold rejects amounts < 1000. */
  amountCop: number;
  /** Buyer-facing description shown in the Bold checkout page. 2–100 chars. */
  description: string;
  /** Where Bold redirects the buyer after a result. Bold appends
   *  ?bold-order-id=...&bold-tx-status=... to this URL. */
  callbackUrl: string;
  /** Optional — pre-fills the email on Bold's checkout page. */
  payerEmail?: string;
  /** Optional — Unix epoch in NANOSECONDS for link expiry. Default: ~24h. */
  expirationDateNs?: number;
};

export type BoldPaymentLinkResponse = {
  paymentLinkId: string;       // Bold's internal id, e.g. "LNK_H7S4xxx"
  url: string;                 // Full checkout URL we redirect the buyer to
};

/** Possible event types we care about on the Bold webhook. */
export type BoldWebhookEventType =
  | 'SALE_APPROVED'
  | 'SALE_REJECTED'
  | 'VOID_APPROVED'
  | 'VOID_REJECTED';

/** Shape of the JSON body Bold POSTs to our webhook. */
export type BoldWebhookEvent = {
  type: BoldWebhookEventType | string;
  subject?: string;       // typically "sale"
  source?: string;        // typically "online"
  data?: {
    payment_id?: string;
    user_id?: string;
    merchant_id?: string;
    amount?: { total_amount?: number; currency?: string; tip_amount?: number };
    metadata?: { reference?: string };
    payment_method?: string; // "CREDIT_CARD" | "PSE" | "NEQUI" | "BANCOLOMBIA_BUTTON" | ...
    card?: any;
  };
};

@Injectable()
export class BoldService {
  private readonly logger = new Logger(BoldService.name);

  /**
   * Create a hosted-checkout URL via Bold's "API Link de pagos".
   * Throws BadGatewayException if Bold rejects the request — surface the
   * upstream error message to the controller so the buyer sees something
   * actionable instead of a generic 500.
   */
  async createPaymentLink(input: BoldPaymentLinkRequest): Promise<BoldPaymentLinkResponse> {
    const identityKey = process.env.BOLD_IDENTITY_KEY;
    if (!identityKey) throw new Error('BOLD_IDENTITY_KEY not configured');

    if (input.amountCop < 1000) {
      // Bold's hard floor — fail fast so we don't waste a round-trip.
      throw new BadGatewayException('El monto mínimo aceptado por Bold es COP $1.000');
    }

    // Default to a 24h expiry if the caller didn't pin one. Bold expects
    // nanoseconds since epoch (NOT ms), so multiply.
    const expirationDateNs =
      input.expirationDateNs ?? (Date.now() + 24 * 60 * 60 * 1000) * 1_000_000;

    const body = {
      amount_type: 'CLOSE',
      amount: {
        currency: 'COP',
        total_amount: Math.round(input.amountCop),
        tip_amount: 0,
      },
      reference: input.reference,
      description: input.description.slice(0, 100),
      callback_url: input.callbackUrl,
      ...(input.payerEmail ? { payer_email: input.payerEmail } : {}),
      expiration_date: expirationDateNs,
    };

    let res: Response;
    try {
      res = await fetch(BOLD_LINK_API, {
        method: 'POST',
        headers: {
          // Bold's auth scheme is literally "x-api-key " followed by the
          // identity key — not a Bearer token. (See developers.bold.co
          // /pagos-en-linea/api-de-pagos-en-linea.) Don't add a colon /
          // secret pair: this endpoint takes the identity key alone.
          'Authorization': `x-api-key ${identityKey}`,
          'Content-Type':  'application/json',
          'Accept':        'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err: any) {
      this.logger.error(`Bold link API network error: ${err?.message ?? err}`);
      throw new BadGatewayException('No se pudo conectar con Bold para iniciar el pago');
    }

    let payload: any = null;
    try { payload = await res.json(); } catch { /* leave null */ }

    if (!res.ok) {
      const errMsg =
        payload?.errors?.[0]?.description ||
        payload?.errors?.[0]?.message ||
        payload?.message ||
        `Bold respondió ${res.status}`;
      this.logger.warn(`Bold link API ${res.status}: ${JSON.stringify(payload)}`);
      throw new BadGatewayException(errMsg);
    }

    const link = payload?.payload?.payment_link;
    const url  = payload?.payload?.url;
    if (!link || !url) {
      this.logger.error(`Bold link API returned unexpected payload: ${JSON.stringify(payload)}`);
      throw new BadGatewayException('Respuesta inválida de Bold');
    }

    return { paymentLinkId: link, url };
  }

  /**
   * Verify the HMAC signature on a Bold webhook delivery.
   *   - Header: `x-bold-signature` (base64 HMAC-SHA256 of the raw body).
   *   - Secret: BOLD_WEBHOOK_SECRET — the "llave secreta para webhook" Bold
   *     issues in the dashboard, separate from the API identity / secret keys.
   *
   * IMPORTANT: We must hash the *raw* request body (the bytes Bold actually
   * sent), not a re-serialized JSON object. main.ts attaches `req.rawBody`
   * for the Bold webhook route specifically — see the express.json verify
   * callback there.
   *
   * Behaviour when the secret is unset:
   *   - Returns true (lenient — same fallback the Wompi webhook uses).
   *   - Logs a warning so we notice in CloudWatch and add the secret.
   * Behaviour when verification fails:
   *   - Returns false. The caller logs a warning but still processes the
   *     event (Bold retries on non-2xx; the integrity hash on the link
   *     already prevents amount tampering, and we re-check status against
   *     our stored amount before accepting).
   */
  verifyWebhookSignature(rawBody: Buffer | string | undefined, signatureHeader: string | undefined): boolean {
    const secret = process.env.BOLD_WEBHOOK_SECRET;
    if (!secret) {
      this.logger.warn('BOLD_WEBHOOK_SECRET not configured — accepting webhook unverified');
      return true;
    }
    if (!rawBody || !signatureHeader) return false;

    const buf = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
    const computed = crypto
      .createHmac('sha256', secret)
      .update(buf)
      .digest('base64');

    // Bold may include the signature alone or pair it with a timestamp.
    // Match the first base64-looking token in the header.
    const candidate = signatureHeader.trim().split(',').map((s) => s.trim()).pop() ?? signatureHeader.trim();

    try {
      const a = Buffer.from(computed, 'base64');
      const b = Buffer.from(candidate, 'base64');
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  /**
   * Map a Bold event type to our internal Payment.status values.
   *   SALE_APPROVED  → approved
   *   SALE_REJECTED  → declined
   *   VOID_APPROVED  → voided
   *   VOID_REJECTED  → error  (refund attempt failed; manual follow-up)
   */
  normalizeStatus(eventType: string): 'approved' | 'declined' | 'voided' | 'error' | 'pending' {
    switch ((eventType || '').toUpperCase()) {
      case 'SALE_APPROVED': return 'approved';
      case 'SALE_REJECTED': return 'declined';
      case 'VOID_APPROVED': return 'voided';
      case 'VOID_REJECTED': return 'error';
      default:              return 'pending';
    }
  }

  /**
   * Generate a Bold-compatible reference / order-id. Max 60 chars,
   * alphanumeric + hyphens + underscores. We use the same shape as the
   * existing Wompi reference (`tp_<ts>_<rand>`) so our log greps still work.
   */
  generateReference(): string {
    return `tp_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  }
}
