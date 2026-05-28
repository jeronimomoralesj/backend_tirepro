import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FlowStatus, TriggerType, ActionType } from '@prisma/client';
import { CreateFlowDto } from './dto/create-flow.dto';
import { UpdateFlowDto } from './dto/update-flow.dto';

@Injectable()
export class AutomationService {
  constructor(private readonly prisma: PrismaService) {}

  async listFlows(companyId: string) {
    return this.prisma.automationFlow.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { runs: true } },
      },
    });
  }

  async getFlow(id: string, companyId: string) {
    const flow = await this.prisma.automationFlow.findUnique({
      where: { id },
      include: {
        runs: { orderBy: { createdAt: 'desc' }, take: 20 },
        _count: { select: { runs: true } },
      },
    });
    if (!flow) throw new NotFoundException('Flow not found');
    if (flow.companyId !== companyId) throw new ForbiddenException();
    return flow;
  }

  async createFlow(companyId: string, userId: string, dto: CreateFlowDto) {
    return this.prisma.automationFlow.create({
      data: {
        companyId,
        createdBy: userId,
        name: dto.name,
        description: dto.description,
        triggerType: dto.triggerType as TriggerType,
        triggerConfig: dto.triggerConfig as any,
        actionType: dto.actionType as ActionType,
        actionConfig: dto.actionConfig as any,
        additionalActions: dto.additionalActions ? (dto.additionalActions as any) : undefined,
        cooldownMinutes: dto.cooldownMinutes ?? 60,
        maxRunsPerDay: dto.maxRunsPerDay ?? 100,
        status: FlowStatus.active,
      },
    });
  }

  async updateFlow(id: string, companyId: string, dto: UpdateFlowDto) {
    const flow = await this.prisma.automationFlow.findUnique({ where: { id } });
    if (!flow) throw new NotFoundException('Flow not found');
    if (flow.companyId !== companyId) throw new ForbiddenException();

    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.triggerType !== undefined) data.triggerType = dto.triggerType;
    if (dto.triggerConfig !== undefined) data.triggerConfig = dto.triggerConfig;
    if (dto.actionType !== undefined) data.actionType = dto.actionType;
    if (dto.actionConfig !== undefined) data.actionConfig = dto.actionConfig;
    if (dto.additionalActions !== undefined) data.additionalActions = dto.additionalActions;
    if (dto.cooldownMinutes !== undefined) data.cooldownMinutes = dto.cooldownMinutes;
    if (dto.maxRunsPerDay !== undefined) data.maxRunsPerDay = dto.maxRunsPerDay;

    return this.prisma.automationFlow.update({
      where: { id },
      data: data as any,
    });
  }

  async deleteFlow(id: string, companyId: string) {
    const flow = await this.prisma.automationFlow.findUnique({ where: { id } });
    if (!flow) throw new NotFoundException('Flow not found');
    if (flow.companyId !== companyId) throw new ForbiddenException();
    await this.prisma.automationFlow.delete({ where: { id } });
    return { deleted: true };
  }

  async toggleFlow(id: string, companyId: string) {
    const flow = await this.prisma.automationFlow.findUnique({ where: { id } });
    if (!flow) throw new NotFoundException('Flow not found');
    if (flow.companyId !== companyId) throw new ForbiddenException();

    const nextStatus =
      flow.status === FlowStatus.active
        ? FlowStatus.paused
        : FlowStatus.active;

    return this.prisma.automationFlow.update({
      where: { id },
      data: {
        status: nextStatus,
        ...(nextStatus === FlowStatus.active && { errorCount: 0, lastError: null }),
      },
    });
  }

  async getFlowRuns(
    flowId: string,
    companyId: string,
    cursor?: string,
    limit = 20,
  ) {
    const flow = await this.prisma.automationFlow.findUnique({
      where: { id: flowId },
    });
    if (!flow) throw new NotFoundException('Flow not found');
    if (flow.companyId !== companyId) throw new ForbiddenException();

    const runs = await this.prisma.flowRun.findMany({
      where: { flowId },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    });

    const hasMore = runs.length > limit;
    const data = hasMore ? runs.slice(0, limit) : runs;
    return {
      data,
      nextCursor: hasMore ? data[data.length - 1].id : null,
    };
  }

  async listIntegrations(companyId: string) {
    const connections = await this.prisma.integrationConnection.findMany({
      where: { companyId },
    });

    return {
      email: { connected: true, system: true },
      whatsapp: { connected: true, system: true },
      google_calendar: (() => {
        const cal = connections.find((c) => c.type === 'google_calendar');
        return {
          connected: !!cal && cal.isActive,
          accountEmail: cal?.accountEmail ?? null,
          accountName: cal?.accountName ?? null,
          lastUsedAt: cal?.lastUsedAt?.toISOString() ?? null,
          lastError: cal?.lastError ?? null,
        };
      })(),
      twilio_phone: (() => {
        const ph = connections.find((c) => c.type === 'twilio_phone');
        return {
          connected: !!ph && ph.isActive,
          accountEmail: ph?.accountEmail ?? null,
        };
      })(),
    };
  }
}
