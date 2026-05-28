import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AutomationFlow, TriggerType } from '@prisma/client';
import { evaluateConditions, ConditionContext } from './conditions';

export interface RotationContext {
  fromPosition?: number;
  toPosition?: number;
  fromVehicleId?: string;
  toVehicleId?: string;
  fromPlaca?: string;
  toPlaca?: string;
}

export interface TriggerContext {
  tireId?: string;
  companyId: string;
  oldAlertLevel?: string;
  newAlertLevel?: string;
  rotation?: RotationContext;
}

@Injectable()
export class TriggerEvaluatorService {
  constructor(private readonly prisma: PrismaService) {}

  async evaluate(
    flow: AutomationFlow,
    ctx: TriggerContext,
  ): Promise<boolean> {
    const config = flow.triggerConfig as Record<string, unknown>;

    // Base trigger match — the "what happened" part. Every type must pass
    // its own check before we run the optional `conditions` filter.
    let baseMatches = false;
    switch (flow.triggerType) {
      case TriggerType.tire_alert_level: {
        const levels = (config.alertLevels ?? []) as string[];
        baseMatches = !!ctx.newAlertLevel && levels.includes(ctx.newAlertLevel);
        break;
      }

      case TriggerType.tire_depth_threshold: {
        if (!ctx.tireId) { baseMatches = false; break; }
        const threshold = (config.thresholdMm ?? 2) as number;
        const tire = await this.prisma.tire.findUnique({
          where: { id: ctx.tireId },
          select: { currentProfundidad: true },
        });
        if (!tire?.currentProfundidad) { baseMatches = false; break; }
        baseMatches = tire.currentProfundidad <= threshold;
        break;
      }

      case TriggerType.tire_eol_approaching: {
        if (!ctx.tireId) { baseMatches = false; break; }
        const days = (config.daysThreshold ?? 30) as number;
        const tire = await this.prisma.tire.findUnique({
          where: { id: ctx.tireId },
          select: { projectedDaysToLimit: true },
        });
        if (tire?.projectedDaysToLimit == null) { baseMatches = false; break; }
        baseMatches = tire.projectedDaysToLimit <= days;
        break;
      }

      case TriggerType.inspection_completed: {
        const levelFilter = config.alertLevelFilter as string[] | undefined;
        baseMatches = !levelFilter || levelFilter.length === 0
          ? true
          : !!ctx.newAlertLevel && levelFilter.includes(ctx.newAlertLevel);
        break;
      }

      case TriggerType.tire_rotation: {
        // Always matches when a rotation event reaches us — the conditions
        // array is where users actually narrow it (from/to position, vehicle
        // type, tire brand, etc.).
        baseMatches = !!ctx.rotation;
        break;
      }

      default:
        baseMatches = false;
    }

    if (!baseMatches) return false;

    // Conditions filter — AND-ed with the base match. Empty/missing means
    // "no extra filtering"; an unresolvable field fails closed.
    const conditions = config.conditions as unknown;
    const condCtx: ConditionContext = {
      tireId: ctx.tireId,
      rotation: ctx.rotation,
      alert: { old: ctx.oldAlertLevel, new: ctx.newAlertLevel },
    };
    return evaluateConditions(conditions, condCtx, this.prisma);
  }
}
