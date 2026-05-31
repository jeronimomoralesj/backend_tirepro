import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AiFeatureName } from './ai-feature.decorator';

// ─────────────────────────────────────────────────────────────────────────────
// Per-plan request quotas. companyMonthly caps the whole company (the real cost
// control — adding users never raises it); userDaily caps a single user so one
// person can't drain the company allowance or spin in a loop. Tune freely; a
// company can override its monthly cap via Company.aiMonthlyLimit.
// ─────────────────────────────────────────────────────────────────────────────
type PlanLimit = { companyMonthly: number; userDaily: number };

const PLAN_AI_LIMITS: Record<string, PlanLimit> = {
  marketplace:  { companyMonthly: 100,  userDaily: 20  },
  plus:         { companyMonthly: 600,  userDaily: 60  },
  pro:          { companyMonthly: 2000, userDaily: 200 },
  distribuidor: { companyMonthly: 8000, userDaily: 500 },
};
const FALLBACK_LIMIT: PlanLimit = PLAN_AI_LIMITS.pro;

// Warn the user once usage crosses this fraction of either limit.
const WARN_THRESHOLD = 0.8;

// Approximate Bedrock pricing in USD per 1K tokens. Used only for the cost
// column on AiUsageEvent (analytics) — not for enforcement. Tune to match the
// AWS price list; unknown models fall back to Nova Lite rates.
const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  'amazon.nova-lite-v1:0': { input: 0.00006, output: 0.00024 },
};
const FALLBACK_PRICE = MODEL_PRICES['amazon.nova-lite-v1:0'];

export interface UsageStatus {
  companyUsed: number;
  companyLimit: number;
  userUsed: number;
  userDailyLimit: number;
  nearLimit: boolean;
}

export interface RecordUsageInput {
  companyId: string;
  userId?: string | null;
  feature: AiFeatureName;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}

@Injectable()
export class AiUsageService {
  private readonly logger = new Logger(AiUsageService.name);

  constructor(private readonly prisma: PrismaService) {}

  private periodBoundaries() {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return { monthStart, dayStart };
  }

  private limitsFor(plan: string | undefined, override: number | null | undefined): PlanLimit {
    const base = (plan && PLAN_AI_LIMITS[plan]) || FALLBACK_LIMIT;
    return {
      companyMonthly: override ?? base.companyMonthly,
      userDaily: base.userDaily,
    };
  }

  /**
   * Throws 429 when the company's monthly or the user's daily request quota is
   * already exhausted. Otherwise returns the current usage (with a nearLimit
   * flag at ≥80%) so callers can surface a warning.
   */
  async assertWithinLimits(companyId: string, userId?: string | null): Promise<UsageStatus> {
    const { monthStart, dayStart } = this.periodBoundaries();

    const [company, companyUsed, userUsed] = await Promise.all([
      this.prisma.company.findUnique({
        where: { id: companyId },
        select: { plan: true, aiMonthlyLimit: true },
      }),
      this.prisma.aiUsageEvent.count({
        where: { companyId, createdAt: { gte: monthStart } },
      }),
      userId
        ? this.prisma.aiUsageEvent.count({ where: { userId, createdAt: { gte: dayStart } } })
        : Promise.resolve(0),
    ]);

    const { companyMonthly, userDaily } = this.limitsFor(company?.plan, company?.aiMonthlyLimit);

    if (companyUsed >= companyMonthly) {
      throw new HttpException(
        {
          code: 'AI_COMPANY_MONTHLY_LIMIT',
          message:
            'Tu empresa alcanzó el límite de consultas de IA de este mes. Contáctanos para ampliar tu plan.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (userId && userUsed >= userDaily) {
      throw new HttpException(
        {
          code: 'AI_USER_DAILY_LIMIT',
          message:
            'Alcanzaste tu límite diario de consultas de IA. Intenta de nuevo mañana o contacta al administrador de tu empresa.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const nearLimit =
      companyUsed >= companyMonthly * WARN_THRESHOLD ||
      (!!userId && userUsed >= userDaily * WARN_THRESHOLD);

    return { companyUsed, companyLimit: companyMonthly, userUsed, userDailyLimit: userDaily, nearLimit };
  }

  estimateCostUsd(model: string | undefined, inputTokens: number, outputTokens: number): number {
    const price = (model && MODEL_PRICES[model]) || FALLBACK_PRICE;
    return (inputTokens / 1000) * price.input + (outputTokens / 1000) * price.output;
  }

  /**
   * Record one completed AI call. This is the durable counter the quotas read
   * from, plus the cost-analytics log. Never throws — usage tracking must not
   * break the user-facing AI response.
   */
  async record(input: RecordUsageInput): Promise<void> {
    const inputTokens = Math.max(0, Math.round(input.inputTokens ?? 0));
    const outputTokens = Math.max(0, Math.round(input.outputTokens ?? 0));
    try {
      await this.prisma.aiUsageEvent.create({
        data: {
          companyId: input.companyId,
          userId: input.userId ?? null,
          feature: input.feature,
          model: input.model ?? null,
          inputTokens,
          outputTokens,
          estimatedCostUsd: this.estimateCostUsd(input.model, inputTokens, outputTokens),
        },
      });
    } catch (err) {
      this.logger.warn(`AI usage record failed: ${(err as Error).message}`);
    }
  }
}
