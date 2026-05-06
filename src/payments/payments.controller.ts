import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PaymentsService } from './payments.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly svc: PaymentsService,
    private readonly jwt: JwtService,
  ) {}

  // ===========================================================================
  // BUYER CHECKOUT — create orders + payment, hand back Wompi widget config.
  // Public endpoint: guest checkout is allowed; if there's a JWT we read
  // the userId off it so the order shows up under "Mis pedidos" in the
  // buyer's profile (was previously dropped — req.user was undefined
  // here because the route had no guard, so userId silently saved as
  // null even for logged-in buyers).
  // ===========================================================================

  @Post('wompi/checkout')
  async checkout(@Req() req: any, @Body() body: {
    items: Array<{
      listingId: string;
      quantity: number;
      /** Optional pickup-point selection per line. When set, that
       *  line ships in `pickup` mode against the named retail point. */
      pickupPointId?: string;
    }>;
    buyerName: string;
    buyerEmail: string;
    buyerPhone?: string;
    buyerAddress?: string;
    buyerCity?: string;
    buyerCompany?: string;
    notas?: string;
    redirectBaseUrl: string;
  }) {
    if (!body?.items?.length) throw new BadRequestException('items required');
    if (!body.redirectBaseUrl?.startsWith('http')) {
      throw new BadRequestException('redirectBaseUrl required');
    }

    // Optional auth: try to decode the Bearer token if present, but
    // don't reject the call if it's missing or invalid — guest
    // checkout still has to work. Any verification failure (bad
    // signature, expired) silently falls back to null userId.
    let userId: string | undefined;
    const authHeader: string | undefined = req?.headers?.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const payload = await this.jwt.verifyAsync(authHeader.slice(7));
        // The JWT strategy uses `sub` for the user id. Match that
        // here — pulling from `payload.sub`, not `payload.userId` or
        // `payload.id`, so this stays consistent with the rest of
        // the auth surface.
        if (payload?.sub && typeof payload.sub === 'string') {
          userId = payload.sub;
        }
      } catch {
        /* invalid / expired token — proceed as guest */
      }
    }

    return this.svc.createCheckout({
      ...body,
      userId,
    });
  }

  // ===========================================================================
  // WEBHOOK — Wompi pings us on every transaction.updated event. Public
  // endpoint, signature-verified inside the service.
  // ===========================================================================

  @Post('wompi/webhook')
  @HttpCode(HttpStatus.OK)
  async webhook(@Body() body: any) {
    return this.svc.handleWebhook(body);
  }

  // ===========================================================================
  // BOLD CHECKOUT — same surface as the Wompi endpoint above, but mints a
  // Bold "API Link de pagos" URL we redirect the buyer to. Public endpoint;
  // optional Bearer auth so logged-in buyers' orders show up in their
  // history. The frontend has been switched to call this; the wompi/checkout
  // route stays alive only so any in-flight redirect/webhook combo from
  // before the cutover can still complete.
  // ===========================================================================
  @Post('bold/checkout')
  async boldCheckout(@Req() req: any, @Body() body: {
    items: Array<{
      listingId: string;
      quantity: number;
      pickupPointId?: string;
    }>;
    buyerName: string;
    buyerEmail: string;
    buyerPhone?: string;
    buyerAddress?: string;
    buyerCity?: string;
    buyerCompany?: string;
    notas?: string;
    redirectBaseUrl: string;
  }) {
    if (!body?.items?.length) throw new BadRequestException('items required');
    if (!body.redirectBaseUrl?.startsWith('http')) {
      throw new BadRequestException('redirectBaseUrl required');
    }

    let userId: string | undefined;
    const authHeader: string | undefined = req?.headers?.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const payload = await this.jwt.verifyAsync(authHeader.slice(7));
        if (payload?.sub && typeof payload.sub === 'string') userId = payload.sub;
      } catch { /* invalid token — proceed as guest */ }
    }

    return this.svc.createBoldCheckout({ ...body, userId });
  }

  // ===========================================================================
  // BOLD BUTTON CONFIG — used when the cart wants to render Bold's official
  // <script data-bold-button> widget instead of redirecting to a hosted
  // checkout link. Returns the data attributes (api key, integrity hash,
  // amount, etc.) for the buyer-facing CTA on the cart page. Same Payment
  // / MarketplaceOrder rows are created up-front as the link flow, so the
  // webhook reconciliation is identical regardless of which path was used.
  // ===========================================================================
  @Post('bold/button-config')
  async boldButtonConfig(@Req() req: any, @Body() body: {
    items: Array<{
      listingId: string;
      quantity: number;
      pickupPointId?: string;
    }>;
    buyerName: string;
    buyerEmail: string;
    buyerPhone?: string;
    buyerAddress?: string;
    buyerCity?: string;
    buyerCompany?: string;
    notas?: string;
    redirectBaseUrl: string;
  }) {
    if (!body?.items?.length) throw new BadRequestException('items required');
    if (!body.redirectBaseUrl?.startsWith('http')) {
      throw new BadRequestException('redirectBaseUrl required');
    }

    let userId: string | undefined;
    const authHeader: string | undefined = req?.headers?.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const payload = await this.jwt.verifyAsync(authHeader.slice(7));
        if (payload?.sub && typeof payload.sub === 'string') userId = payload.sub;
      } catch { /* invalid token — proceed as guest */ }
    }

    return this.svc.createBoldButtonConfig({ ...body, userId });
  }

  // ===========================================================================
  // BOLD WEBHOOK — Bold pings us on SALE_APPROVED / SALE_REJECTED /
  // VOID_APPROVED / VOID_REJECTED. Public endpoint, signature-verified
  // inside the service against `req.rawBody` (set up in main.ts so Bold's
  // HMAC matches the bytes we received, not a re-stringified copy).
  // ===========================================================================
  @Post('bold/webhook')
  @HttpCode(HttpStatus.OK)
  async boldWebhook(@Req() req: any, @Body() body: any) {
    return this.svc.handleBoldWebhook({
      body,
      rawBody:         req?.rawBody,
      signatureHeader: req?.headers?.['x-bold-signature'],
    });
  }

  // ===========================================================================
  // BOLD RECONCILE — webhook-failure rescue. The order tracking page
  // calls this when a buyer lands back from Bold but the order is still
  // `pago_pendiente` (i.e. webhook hasn't arrived yet). We poll Bold's
  // transaction-status API for the truth and resolve the Payment + Orders
  // accordingly. Idempotent and safe to call repeatedly.
  //
  // Public endpoint: the reference is server-generated and unguessable
  // (`tp_<ts>_<rand>`), and Bold's API is the source of truth, so an
  // attacker hitting it gains nothing.
  // ===========================================================================
  @Post('bold/reconcile/:reference')
  @HttpCode(HttpStatus.OK)
  async boldReconcile(@Param('reference') reference: string) {
    if (!reference?.startsWith('tp_')) {
      throw new BadRequestException('Invalid reference');
    }
    return this.svc.reconcileBoldPayment(reference);
  }

  // ===========================================================================
  // DISTRIBUTOR BANK ACCOUNT — onboarding from /dashboard/marketplace/perfil
  // ===========================================================================

  @Get('me/account')
  @UseGuards(JwtAuthGuard)
  async getMyAccount(@Req() req: any) {
    const companyId = req?.user?.companyId;
    if (!companyId) throw new BadRequestException('No company on session');
    return this.svc.getMyAccount(companyId);
  }

  @Patch('me/account')
  @UseGuards(JwtAuthGuard)
  async upsertMyAccount(@Req() req: any, @Body() body: {
    holderName: string;
    documentType: string;
    documentNumber: string;
    bankName: string;
    accountType: string;
    accountNumber: string;
    notificationEmail?: string | null;
  }) {
    const companyId = req?.user?.companyId;
    if (!companyId) throw new BadRequestException('No company on session');
    return this.svc.upsertMyAccount(companyId, body);
  }

  // ===========================================================================
  // ADMIN PAYOUT QUEUE — the back-office page that lists who to pay.
  // Gated by role check inside the service / controller; for now we
  // allow any authenticated user with `tirepro_admin` role on their JWT.
  // (We can switch to a separate AdminPasswordGuard later if needed.)
  // ===========================================================================

  @Get('admin/payouts/queue')
  @UseGuards(JwtAuthGuard)
  async getPayoutQueue(@Req() req: any) {
    if (req?.user?.role !== 'tirepro_admin') {
      throw new BadRequestException('Admin only');
    }
    return this.svc.getPayoutQueue();
  }

  @Post('admin/payouts/release')
  @UseGuards(JwtAuthGuard)
  async releasePayout(@Req() req: any, @Body() body: {
    distributorId: string;
    bankReferenceNumber: string;
    notes?: string;
  }) {
    if (req?.user?.role !== 'tirepro_admin') {
      throw new BadRequestException('Admin only');
    }
    return this.svc.releasePayout({
      ...body,
      releasedByUserId: req?.user?.id,
    });
  }
}
