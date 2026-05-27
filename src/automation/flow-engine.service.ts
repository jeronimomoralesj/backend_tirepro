import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FlowStatus, TriggerType } from '@prisma/client';
import { TriggerEvaluatorService, TriggerContext } from './trigger-evaluator.service';
import { ActionExecutorService } from './action-executor.service';

@Injectable()
export class FlowEngineService {
  private readonly logger = new Logger(FlowEngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly triggerEvaluator: TriggerEvaluatorService,
    private readonly actionExecutor: ActionExecutorService,
  ) {}

  async onTireStateChanged(
    tireId: string,
    companyId: string,
    oldAlertLevel: string,
    newAlertLevel: string,
  ): Promise<void> {
    const flows = await this.prisma.automationFlow.findMany({
      where: {
        companyId,
        status: FlowStatus.active,
        triggerType: {
          in: [
            TriggerType.tire_alert_level,
            TriggerType.tire_depth_threshold,
            TriggerType.tire_eol_approaching,
            TriggerType.inspection_completed,
          ],
        },
      },
    });

    if (flows.length === 0) return;

    const ctx: TriggerContext = {
      tireId,
      companyId,
      oldAlertLevel,
      newAlertLevel,
    };

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    for (const flow of flows) {
      try {
        const shouldFire = await this.triggerEvaluator.evaluate(flow, ctx);
        if (!shouldFire) continue;

        const recentRun = await this.prisma.flowRun.findFirst({
          where: {
            flowId: flow.id,
            entityId: tireId,
            createdAt: {
              gte: new Date(Date.now() - flow.cooldownMinutes * 60_000),
            },
          },
          select: { id: true },
        });
        if (recentRun) continue;

        const todayRuns = await this.prisma.flowRun.count({
          where: {
            flowId: flow.id,
            createdAt: { gte: startOfDay },
          },
        });
        if (todayRuns >= flow.maxRunsPerDay) continue;

        await this.actionExecutor.execute(flow, { tireId, companyId });
      } catch (err: any) {
        this.logger.error(
          `Flow engine error for flow ${flow.id}: ${err.message}`,
          err.stack,
        );
      }
    }
  }
}
