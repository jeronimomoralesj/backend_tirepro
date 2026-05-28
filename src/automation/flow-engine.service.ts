import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FlowStatus, TriggerType } from '@prisma/client';
import { TriggerEvaluatorService, TriggerContext, RotationContext } from './trigger-evaluator.service';
import { ActionExecutorService } from './action-executor.service';

type PendingBatch = {
  tireIds: Set<string>;
  companyId: string;
  timer: ReturnType<typeof setTimeout>;
};

@Injectable()
export class FlowEngineService {
  private readonly logger = new Logger(FlowEngineService.name);
  private readonly pendingBatches = new Map<string, PendingBatch>();
  private static readonly BATCH_DELAY_MS = 8_000;

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

        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const todayRuns = await this.prisma.flowRun.count({
          where: { flowId: flow.id, createdAt: { gte: startOfDay } },
        });
        if (todayRuns >= flow.maxRunsPerDay) continue;

        if (flow.actionType === 'create_calendar_event') {
          this.addToBatch(flow.id, tireId, companyId);
        } else {
          await this.actionExecutor.execute(flow, { tireId, companyId });
        }
      } catch (err: any) {
        this.logger.error(
          `Flow engine error for flow ${flow.id}: ${err.message}`,
          err.stack,
        );
      }
    }
  }

  /**
   * Called when a tire's position or vehicle changes (rotation).
   * Fires tire_rotation flows that match the new context.
   */
  async onTireRotated(
    tireId: string,
    companyId: string,
    rotation: RotationContext,
  ): Promise<void> {
    const flows = await this.prisma.automationFlow.findMany({
      where: {
        companyId,
        status: FlowStatus.active,
        triggerType: TriggerType.tire_rotation,
      },
    });

    if (flows.length === 0) return;

    const ctx: TriggerContext = { tireId, companyId, rotation };

    for (const flow of flows) {
      try {
        const shouldFire = await this.triggerEvaluator.evaluate(flow, ctx);
        if (!shouldFire) continue;

        const recentRun = await this.prisma.flowRun.findFirst({
          where: {
            flowId: flow.id,
            entityId: tireId,
            createdAt: { gte: new Date(Date.now() - flow.cooldownMinutes * 60_000) },
          },
          select: { id: true },
        });
        if (recentRun) continue;

        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const todayRuns = await this.prisma.flowRun.count({
          where: { flowId: flow.id, createdAt: { gte: startOfDay } },
        });
        if (todayRuns >= flow.maxRunsPerDay) continue;

        await this.actionExecutor.execute(flow, { tireId, companyId });
      } catch (err: any) {
        this.logger.error(
          `Rotation flow ${flow.id} failed: ${err.message}`,
          err.stack,
        );
      }
    }
  }

  private addToBatch(flowId: string, tireId: string, companyId: string) {
    const existing = this.pendingBatches.get(flowId);
    if (existing) {
      existing.tireIds.add(tireId);
      return;
    }

    const batch: PendingBatch = {
      tireIds: new Set([tireId]),
      companyId,
      timer: setTimeout(() => this.flushBatch(flowId), FlowEngineService.BATCH_DELAY_MS),
    };
    this.pendingBatches.set(flowId, batch);
  }

  private async flushBatch(flowId: string) {
    const batch = this.pendingBatches.get(flowId);
    if (!batch) return;
    this.pendingBatches.delete(flowId);

    const tireIds = [...batch.tireIds];
    this.logger.log(`Flushing batch for flow ${flowId}: ${tireIds.length} tire(s)`);

    try {
      const flow = await this.prisma.automationFlow.findUnique({ where: { id: flowId } });
      if (!flow || flow.status !== FlowStatus.active) return;

      await this.actionExecutor.execute(flow, {
        companyId: batch.companyId,
        tireId: tireIds[0],
        tireIds,
      });
    } catch (err: any) {
      this.logger.error(`Batch execution error for flow ${flowId}: ${err.message}`, err.stack);
    }
  }
}
