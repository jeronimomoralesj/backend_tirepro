import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AI_FEATURE_KEY, type AiFeatureName } from './ai-feature.decorator';
import { AiUsageService } from './ai-usage.service';

/**
 * Enforces per-company / per-user AI request quotas on routes marked with
 * @AiFeature(). Runs after JwtAuthGuard, so req.user is populated. On a route
 * without @AiFeature it's a no-op. When the caller is within limits it stashes
 * the usage status on req.aiUsage so the handler can surface an 80% warning.
 */
@Injectable()
export class AiUsageGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly aiUsage: AiUsageService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<AiFeatureName | undefined>(AI_FEATURE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!feature) return true; // not an AI route

    const req = context.switchToHttp().getRequest();
    const companyId: string | undefined = req.user?.companyId;
    const userId: string | undefined = req.user?.userId;

    // Without a company we can't key the quota — let other guards decide auth.
    if (!companyId) return true;

    // Throws 429 when a quota is exhausted; otherwise returns current usage.
    req.aiUsage = await this.aiUsage.assertWithinLimits(companyId, userId);
    return true;
  }
}
