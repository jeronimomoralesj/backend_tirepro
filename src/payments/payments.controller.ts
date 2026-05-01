import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly svc: PaymentsService) {}

  // ===========================================================================
  // BUYER CHECKOUT — create orders + payment, hand back Wompi widget config.
  // Public endpoint: guest checkout is allowed; if there's a JWT we read
  // the userId off it.
  // ===========================================================================

  @Post('wompi/checkout')
  async checkout(@Req() req: any, @Body() body: {
    items: Array<{ listingId: string; quantity: number }>;
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
    return this.svc.createCheckout({
      ...body,
      userId: req?.user?.id,
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
