import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  BadRequestException,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CompanyScopeGuard } from '../auth/guards/company-scope.guard';
import { PurchaseOrdersService } from './purchase-orders.service';

@Controller('purchase-orders')
@UseGuards(JwtAuthGuard, CompanyScopeGuard)
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
export class PurchaseOrdersController {
  constructor(private readonly purchaseOrdersService: PurchaseOrdersService) {}

  // ── Static routes first ─────────────────────────────────────────────────────

  @Get('company')
  getForCompany(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.purchaseOrdersService.getOrdersForCompany(companyId);
  }

  @Get('distributor')
  getForDistributor(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.purchaseOrdersService.getOrdersForDistributor(companyId);
  }

  // ── Create ──────────────────────────────────────────────────────────────────

  @Post()
  create(
    @Body()
    body: {
      companyId: string;
      distributorId: string;
      items: any[];
      totalEstimado?: number;
      notas?: string;
    },
  ) {
    if (!body.companyId || !body.distributorId || !body.items?.length) {
      throw new BadRequestException('companyId, distributorId, and items are required');
    }
    return this.purchaseOrdersService.createOrder(
      body.companyId,
      body.distributorId,
      body.items,
      body.totalEstimado,
      body.notas,
    );
  }

  // ── Param routes ────────────────────────────────────────────────────────────

  @Patch(':id/cotizacion')
  submitCotizacion(
    @Param('id') id: string,
    @Body() body: { distributorId: string; cotizacion: any[]; totalCotizado: number; notas?: string },
  ) {
    return this.purchaseOrdersService.submitCotizacion(
      id,
      body.distributorId,
      body.cotizacion,
      body.totalCotizado,
      body.notas,
    );
  }

  @Patch(':id/accept')
  accept(@Param('id') id: string, @Body() body: { companyId: string }) {
    return this.purchaseOrdersService.acceptOrder(id, body.companyId);
  }

  @Patch(':id/reject')
  reject(@Param('id') id: string, @Body() body: { companyId: string; notas?: string }) {
    return this.purchaseOrdersService.rejectOrder(id, body.companyId, body.notas);
  }

  @Patch(':id/revision')
  requestRevision(@Param('id') id: string, @Body() body: { companyId: string; notas: string }) {
    return this.purchaseOrdersService.requestRevision(id, body.companyId, body.notas);
  }
}
