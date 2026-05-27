import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AutomationFlow, TriggerType } from '@prisma/client';

export interface TriggerContext {
  tireId?: string;
  companyId: string;
  oldAlertLevel?: string;
  newAlertLevel?: string;
}

@Injectable()
export class TriggerEvaluatorService {
  constructor(private readonly prisma: PrismaService) {}

  async evaluate(
    flow: AutomationFlow,
    ctx: TriggerContext,
  ): Promise<boolean> {
    const config = flow.triggerConfig as Record<string, unknown>;

    switch (flow.triggerType) {
      case TriggerType.tire_alert_level: {
        const levels = (config.alertLevels ?? []) as string[];
        return !!ctx.newAlertLevel && levels.includes(ctx.newAlertLevel);
      }

      case TriggerType.tire_depth_threshold: {
        if (!ctx.tireId) return false;
        const threshold = (config.thresholdMm ?? 2) as number;
        const tire = await this.prisma.tire.findUnique({
          where: { id: ctx.tireId },
          select: { currentProfundidad: true },
        });
        if (!tire?.currentProfundidad) return false;
        return tire.currentProfundidad <= threshold;
      }

      case TriggerType.tire_eol_approaching: {
        if (!ctx.tireId) return false;
        const days = (config.daysThreshold ?? 30) as number;
        const tire = await this.prisma.tire.findUnique({
          where: { id: ctx.tireId },
          select: { projectedDaysToLimit: true },
        });
        if (tire?.projectedDaysToLimit == null) return false;
        return tire.projectedDaysToLimit <= days;
      }

      case TriggerType.inspection_completed: {
        const levelFilter = config.alertLevelFilter as string[] | undefined;
        if (!levelFilter || levelFilter.length === 0) return true;
        return !!ctx.newAlertLevel && levelFilter.includes(ctx.newAlertLevel);
      }

      default:
        return false;
    }
  }
}
