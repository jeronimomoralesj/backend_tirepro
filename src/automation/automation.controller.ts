import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
  BadRequestException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AutomationService } from './automation.service';
import { AiFlowBuilderService } from './ai-flow-builder.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateFlowDto } from './dto/create-flow.dto';
import { UpdateFlowDto } from './dto/update-flow.dto';

type AuthReq = { user?: { userId?: string; companyId?: string; role?: string } };

@Controller('automation')
@UseGuards(JwtAuthGuard)
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
export class AutomationController {
  constructor(
    private readonly svc: AutomationService,
    private readonly aiFlowBuilder: AiFlowBuilderService,
    private readonly prisma: PrismaService,
  ) {}

  private extractCompany(req: AuthReq, requireAdmin = true): { companyId: string; userId: string } {
    const companyId = req.user?.companyId;
    const userId = req.user?.userId;
    if (!companyId) throw new BadRequestException('No company');
    if (requireAdmin && req.user?.role !== 'admin') throw new BadRequestException('Admin only');
    return { companyId, userId: userId ?? '' };
  }

  private async buildQuickFleetSummary(companyId: string): Promise<string> {
    const tires = await this.prisma.tire.findMany({
      where: { companyId },
      select: {
        marca: true, diseno: true, dimension: true, eje: true, vidaActual: true,
        currentProfundidad: true, currentCpk: true, lifetimeCpk: true, alertLevel: true,
        posicion: true, healthScore: true,
        vehicle: { select: { placa: true, tipovhc: true } },
        costos: { select: { valor: true, concepto: true } },
      },
    });
    if (!tires.length) return 'Sin datos de llantas.';

    const L: string[] = [];
    const critical = tires.filter(t => t.currentProfundidad != null && t.currentProfundidad <= 2);
    const warning = tires.filter(t => t.currentProfundidad != null && t.currentProfundidad > 2 && t.currentProfundidad <= 4);
    const watch = tires.filter(t => t.currentProfundidad != null && t.currentProfundidad > 4 && t.currentProfundidad <= 6);
    const totalCost = tires.reduce((s, t) => s + t.costos.reduce((a, c) => a + (c.valor || 0), 0), 0);

    L.push(`FLOTA: ${tires.length} llantas`);
    L.push(`ALERTAS: critical:${critical.length} warning:${warning.length} watch:${watch.length} ok:${tires.length - critical.length - warning.length - watch.length}`);
    if (totalCost > 0) L.push(`INVERSION TOTAL: $${totalCost.toLocaleString('es-CO')}`);

    const byBrand: Record<string, { n: number; cpkSum: number; cpkN: number }> = {};
    for (const t of tires) {
      const b = t.marca || 'Otro';
      if (!byBrand[b]) byBrand[b] = { n: 0, cpkSum: 0, cpkN: 0 };
      byBrand[b].n++;
      const cpk = t.lifetimeCpk ?? t.currentCpk;
      if (cpk != null && cpk > 0) { byBrand[b].cpkSum += cpk; byBrand[b].cpkN++; }
    }
    L.push(`MARCAS: ${Object.entries(byBrand).sort((a, b) => b[1].n - a[1].n).map(([b, v]) => `${b}:${v.n}/${v.cpkN > 0 ? `$${(v.cpkSum / v.cpkN).toFixed(0)}` : '-'}`).join(' ')}`);

    if (critical.length > 0) {
      L.push(`\nCRITICAS(${critical.length}):`);
      L.push('Vehiculo|Marca|Diseno|Prof|Posicion|CPK|Costo');
      for (const t of critical.slice(0, 15)) {
        const cpk = t.lifetimeCpk ?? t.currentCpk;
        const cost = t.costos.reduce((a, c) => a + (c.valor || 0), 0);
        L.push(`${t.vehicle?.placa ?? '?'}|${t.marca}|${t.diseno ?? '?'}|${t.currentProfundidad?.toFixed(1)}mm|${t.posicion}|${cpk != null ? `$${cpk.toFixed(0)}` : '-'}|$${cost.toLocaleString('es-CO')}`);
      }
    }

    const byEje: Record<string, number> = {};
    for (const t of tires) { byEje[t.eje || 'otro'] = (byEje[t.eje || 'otro'] || 0) + 1; }
    L.push(`EJES: ${Object.entries(byEje).map(([e, n]) => `${e}:${n}`).join(' ')}`);

    const byVida: Record<string, number> = {};
    for (const t of tires) { byVida[t.vidaActual || 'nueva'] = (byVida[t.vidaActual || 'nueva'] || 0) + 1; }
    L.push(`VIDAS: ${Object.entries(byVida).map(([v, n]) => `${v}:${n}`).join(' ')}`);

    return L.join('\n');
  }

  @Post('ai-builder')
  @HttpCode(HttpStatus.OK)
  async aiBuilder(
    @Req() req: AuthReq,
    @Body() body: { description?: string; currentFlow?: Record<string, unknown> },
  ) {
    this.extractCompany(req);
    const description = body?.description;
    if (!description || typeof description !== 'string' || !description.trim()) {
      throw new BadRequestException('Se requiere una descripcion del flujo');
    }
    return this.aiFlowBuilder.buildFlow(description.trim(), body.currentFlow);
  }

  @Post('ai-report-builder')
  @HttpCode(HttpStatus.OK)
  async aiReportBuilder(
    @Req() req: AuthReq,
    @Body() body: { description?: string; currentBlocks?: unknown[] },
  ) {
    const { companyId } = this.extractCompany(req);
    const description = body?.description;
    if (!description || typeof description !== 'string' || !description.trim()) {
      throw new BadRequestException('Se requiere una descripcion del reporte');
    }
    const fleetData = await this.buildQuickFleetSummary(companyId);
    return this.aiFlowBuilder.buildReportBlocks(description.trim(), fleetData, body.currentBlocks);
  }

  @Get('flows')
  listFlows(@Req() req: AuthReq) {
    const { companyId } = this.extractCompany(req);
    return this.svc.listFlows(companyId);
  }

  @Post('flows')
  @HttpCode(HttpStatus.CREATED)
  createFlow(@Req() req: AuthReq, @Body() dto: CreateFlowDto) {
    const { companyId, userId } = this.extractCompany(req);
    return this.svc.createFlow(companyId, userId, dto);
  }

  @Get('flows/:id')
  getFlow(@Req() req: AuthReq, @Param('id') id: string) {
    const { companyId } = this.extractCompany(req);
    return this.svc.getFlow(id, companyId);
  }

  @Patch('flows/:id')
  updateFlow(
    @Req() req: AuthReq,
    @Param('id') id: string,
    @Body() dto: UpdateFlowDto,
  ) {
    const { companyId } = this.extractCompany(req);
    return this.svc.updateFlow(id, companyId, dto);
  }

  @Delete('flows/:id')
  deleteFlow(@Req() req: AuthReq, @Param('id') id: string) {
    const { companyId } = this.extractCompany(req);
    return this.svc.deleteFlow(id, companyId);
  }

  @Patch('flows/:id/toggle')
  toggleFlow(@Req() req: AuthReq, @Param('id') id: string) {
    const { companyId } = this.extractCompany(req);
    return this.svc.toggleFlow(id, companyId);
  }

  @Get('flows/:id/runs')
  getFlowRuns(
    @Req() req: AuthReq,
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const { companyId } = this.extractCompany(req);
    return this.svc.getFlowRuns(id, companyId, cursor, limit ? parseInt(limit, 10) : 20);
  }

  @Get('integrations')
  listIntegrations(@Req() req: AuthReq) {
    const { companyId } = this.extractCompany(req);
    return this.svc.listIntegrations(companyId);
  }
}
