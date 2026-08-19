import "server-only";

import { apiError } from "@/lib/api-response";
import { getProductionHardeningPolicy } from "@/lib/config/production-hardening";
import { checkRateLimit, type RateLimitCategory } from "@/lib/rate-limit/fixed-window";

/**
 * Shared enforcement helper for the three job-creating route categories
 * (021-production-hardening-garbage-collection, User Story 7). Returns
 * `null` when the caller is within budget (the route proceeds normally —
 * no field is added to a successful response, per
 * `contracts/rate-limit-error.md`); returns a ready-to-return `429`
 * response, matching that contract exactly (including `Retry-After`),
 * when the caller has exceeded it.
 *
 * Call this *before* any `Job`/`PreparedImport`/`AiTask` row is created —
 * every one of the five call sites in this feature does.
 */
export async function enforceRateLimit(actorId: string, category: RateLimitCategory) {
  const policy = getProductionHardeningPolicy();
  const limit = category === "ai-task"
    ? policy.RATE_LIMIT_AI_TASK_PER_MINUTE
    : category === "import"
      ? policy.RATE_LIMIT_IMPORT_PER_MINUTE
      : policy.RATE_LIMIT_EXPORT_PER_MINUTE;

  const result = await checkRateLimit({ userId: actorId, category, limit, windowSeconds: 60 });
  if (result.allowed) return null;

  return apiError(
    429,
    "RATE_LIMITED",
    `You have created too many ${category} requests. Try again in ${result.retryAfterSeconds} seconds.`,
    undefined,
    { "Retry-After": String(result.retryAfterSeconds) },
  );
}
