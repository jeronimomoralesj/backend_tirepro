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
import {
  PurchaseOrdersService,
  CreateItemInput,
  CotizacionItemInput,
} from './purchase-orders.service';

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
      items: CreateItemInput[];
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
    @Body() body: {
      distributorId: string;
      cotizacion: CotizacionItemInput[];
      totalCotizado: number;
      notas?: string;
    },
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

  // ── Pickup lifecycle ────────────────────────────────────────────────────────

  // Distributor sets a pickup date after the fleet has accepted. Doesn't
  // move tires; just tells the fleet "we'll be there on this day".
  @Patch(':id/schedule-pickup')
  schedulePickup(
    @Param('id') id: string,
    @Body() body: { distributorId: string; pickupDate: string },
  ) {
    if (!body.distributorId || !body.pickupDate) {
      throw new BadRequestException('distributorId and pickupDate are required');
    }
    return this.purchaseOrdersService.schedulePickup(id, body.distributorId, body.pickupDate);
  }

  // Distributor confirms which tires they physically collected at pickup.
  // Items not in itemIds stay in `cotizada` so the dist can come back
  // for them later (tire wasn't at the facility that day, etc.).
  @Post(':id/recoger')
  recogerItems(
    @Param('id') id: string,
    @Body() body: { distributorId: string; itemIds: string[] },
  ) {
    if (!body.distributorId || !Array.isArray(body.itemIds) || body.itemIds.length === 0) {
      throw new BadRequestException('distributorId and itemIds are required');
    }
    return this.purchaseOrdersService.recogerItems(id, body.distributorId, body.itemIds);
  }

  // Distributor runs the per-tire decision step. Body carries one
  // decision per collected item (reencauchar / devolver / fin_de_vida);
  // each decision triggers the appropriate tire move + item state
  // transition in a single batch. Items must already be in
  // recogida_por_dist (call /recoger first).
  @Post(':id/pickup')
  performPickup(
    @Param('id') id: string,
    @Body() body: { distributorId: string; decisions: any[] },
  ) {
    if (!body.distributorId || !Array.isArray(body.decisions) || body.decisions.length === 0) {
      throw new BadRequestException('distributorId and decisions are required');
    }
    return this.purchaseOrdersService.performPickup(id, body.distributorId, body.decisions);
  }

  // ── Reencauche lifecycle ───────────────────────────────────────────────────

  // Fleet hands the tires over: moves them into the Reencauche bucket and
  // flips each reencauche item to `en_reencauche_bucket`.
  @Post(':id/reencauche/send')
  sendReencaucheTiresToBucket(
    @Param('id') id: string,
    @Body() body: { companyId: string },
  ) {
    if (!body.companyId) throw new BadRequestException('companyId is required');
    return this.purchaseOrdersService.sendReencaucheTiresToBucket(id, body.companyId);
  }

  // Distributor approves one reencauche item with an ETA.
  @Patch('items/:itemId/approve')
  approveReencaucheItem(
    @Param('itemId') itemId: string,
    @Body() body: { distributorId: string; estimatedDelivery: string },
  ) {
    if (!body.distributorId || !body.estimatedDelivery) {
      throw new BadRequestException('distributorId and estimatedDelivery are required');
    }
    return this.purchaseOrdersService.approveReencaucheItem(
      itemId,
      body.distributorId,
      body.estimatedDelivery,
    );
  }

  // Distributor decided the tire isn't retreadable for this job but it's
  // still usable — ship it back to the fleet's Disponible bucket. No
  // desechos form; just a short motivo so the fleet knows why.
  @Patch('items/:itemId/return-to-disponible')
  returnItemToDisponible(
    @Param('itemId') itemId: string,
    @Body() body: { distributorId: string; motivoRechazo: string },
  ) {
    if (!body.distributorId || !body.motivoRechazo) {
      throw new BadRequestException('distributorId and motivoRechazo are required');
    }
    return this.purchaseOrdersService.returnItemToDisponible(
      itemId,
      body.distributorId,
      body.motivoRechazo,
    );
  }

  // Distributor rejects one reencauche item and files the fin-de-vida form
  // (causales / milimetros / photos) that routes the tire to fin-de-vida.
  @Patch('items/:itemId/reject')
  rejectReencaucheItem(
    @Param('itemId') itemId: string,
    @Body() body: {
      distributorId: string;
      motivoRechazo: string;
      desechos: { causales: string; milimetrosDesechados: number; imageUrls?: string[] };
    },
  ) {
    if (!body.distributorId || !body.motivoRechazo || !body.desechos) {
      throw new BadRequestException('distributorId, motivoRechazo and desechos are required');
    }
    return this.purchaseOrdersService.rejectReencaucheItem(
      itemId,
      body.distributorId,
      body.motivoRechazo,
      body.desechos,
    );
  }

  // Distributor hands a batch of tires back. Each delivery carries the
  // retread details needed to progress the tire's vida (banda, costo, etc.).
  @Post(':id/entregar')
  entregarReencaucheItems(
    @Param('id') id: string,
    @Body() body: {
      distributorId: string;
      deliveries: Array<{
        tireId:             string;
        banda:              string;
        bandaMarca?:        string;
        costo:              number;
        profundidadInicial: number;
        proveedor?:         string;
      }>;
    },
  ) {
    if (!body.distributorId || !Array.isArray(body.deliveries) || body.deliveries.length === 0) {
      throw new BadRequestException('distributorId and deliveries are required');
    }
    return this.purchaseOrdersService.entregarReencaucheItems(
      id,
      body.distributorId,
      body.deliveries,
    );
  }
}
