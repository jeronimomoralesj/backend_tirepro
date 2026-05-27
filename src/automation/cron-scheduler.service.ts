import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { ActionExecutorService } from './action-executor.service';
import { FlowStatus, TriggerType } from '@prisma/client';

@Injectable()
export class CronSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(CronSchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly actionExecutor: ActionExecutorService,
  ) {}

  onModuleInit() {
    this.logger.log(
      'CronSchedulerService initialized — checking scheduled flows every minute',
    );
  }

  @Cron('* * * * *', { name: 'automation-cron-scheduler' })
  async tick() {
    const flows = await this.prisma.automationFlow.findMany({
      where: {
        triggerType: TriggerType.scheduled_cron,
        status: FlowStatus.active,
      },
    });

    if (flows.length === 0) return;

    const now = new Date();

    for (const flow of flows) {
      try {
        const config = flow.triggerConfig as Record<string, unknown>;
        const cronExpr = config.cron as string | undefined;
        if (!cronExpr) {
          this.logger.warn(
            `Flow ${flow.id} has no cron expression in triggerConfig`,
          );
          continue;
        }

        const tz = (config.timezone as string) || 'America/Bogota';

        if (!this.cronMatchesNow(cronExpr, tz, now)) continue;

        const startOfDay = new Date(now);
        startOfDay.setHours(0, 0, 0, 0);
        const todayRuns = await this.prisma.flowRun.count({
          where: { flowId: flow.id, createdAt: { gte: startOfDay } },
        });
        if (todayRuns >= flow.maxRunsPerDay) {
          this.logger.debug(
            `Flow ${flow.id} hit maxRunsPerDay (${flow.maxRunsPerDay})`,
          );
          continue;
        }

        if (flow.lastRunAt) {
          const msSinceLastRun = now.getTime() - flow.lastRunAt.getTime();
          if (msSinceLastRun < flow.cooldownMinutes * 60_000) {
            this.logger.debug(`Flow ${flow.id} still in cooldown`);
            continue;
          }
        }

        this.logger.log(
          `Executing scheduled flow ${flow.id} ("${flow.name}") — cron: ${cronExpr}`,
        );
        await this.actionExecutor.execute(flow, {
          companyId: flow.companyId,
        });
      } catch (err: any) {
        this.logger.error(
          `Scheduled flow ${flow.id} failed: ${err.message}`,
          err.stack,
        );
      }
    }
  }

  private cronMatchesNow(cronExpr: string, tz: string, now: Date): boolean {
    try {
      const localeStr = now.toLocaleString('en-US', { timeZone: tz });
      const localeNow = new Date(localeStr);

      const parts = cronExpr.trim().split(/\s+/);
      if (parts.length !== 5) return false;

      const [minPart, hourPart, domPart, monPart, dowPart] = parts;
      const minute = localeNow.getMinutes();
      const hour = localeNow.getHours();
      const dayOfMonth = localeNow.getDate();
      const month = localeNow.getMonth() + 1;
      const dayOfWeek = localeNow.getDay();

      return (
        this.fieldMatches(minPart, minute, 0, 59) &&
        this.fieldMatches(hourPart, hour, 0, 23) &&
        this.fieldMatches(domPart, dayOfMonth, 1, 31) &&
        this.fieldMatches(monPart, month, 1, 12) &&
        this.fieldMatches(dowPart, dayOfWeek, 0, 7)
      );
    } catch (err) {
      this.logger.error(`Failed to parse cron expression "${cronExpr}": ${err}`);
      return false;
    }
  }

  private fieldMatches(
    field: string,
    value: number,
    _min: number,
    _max: number,
  ): boolean {
    if (field === '*') return true;

    for (const part of field.split(',')) {
      const [rangePart, stepStr] = part.split('/');
      const step = stepStr ? parseInt(stepStr, 10) : 1;

      if (rangePart === '*') {
        if (value % step === 0) return true;
        continue;
      }

      const rangeBits = rangePart.split('-');
      if (rangeBits.length === 2) {
        const lo = parseInt(rangeBits[0], 10);
        const hi = parseInt(rangeBits[1], 10);
        if (value >= lo && value <= hi && (value - lo) % step === 0)
          return true;
      } else {
        let exact = parseInt(rangePart, 10);
        if (exact === 7) exact = 0;
        if (value === exact) return true;
      }
    }

    return false;
  }
}
