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
  ) {}

  private extractCompany(req: AuthReq, requireAdmin = true): { companyId: string; userId: string } {
    const companyId = req.user?.companyId;
    const userId = req.user?.userId;
    if (!companyId) throw new BadRequestException('No company');
    if (requireAdmin && req.user?.role !== 'admin') throw new BadRequestException('Admin only');
    return { companyId, userId: userId ?? '' };
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
      throw new BadRequestException('Se requiere una descripción del flujo');
    }
    return this.aiFlowBuilder.buildFlow(description.trim(), body.currentFlow);
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
