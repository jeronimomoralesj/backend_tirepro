import { SetMetadata } from '@nestjs/common';

export type AiFeatureName = 'chat' | 'bulk_analyze' | 'automation';

export const AI_FEATURE_KEY = 'ai_feature';

/**
 * Marks a route as an AI endpoint so AiUsageGuard enforces per-company /
 * per-user request quotas on it. The value is the feature label stored on
 * each AiUsageEvent row.
 */
export const AiFeature = (feature: AiFeatureName) =>
  SetMetadata(AI_FEATURE_KEY, feature);
