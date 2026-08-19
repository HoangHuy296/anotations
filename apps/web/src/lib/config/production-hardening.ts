import "server-only";

import { z } from "zod";

/**
 * Production-hardening thresholds for `apps/web` (021-production-hardening-
 * garbage-collection): per-user rate limits and the pagination page-size
 * ceiling. Mirrors the `z.coerce.number()...default()` convention already
 * used by `apps/worker/src/config.ts`'s `repositoryImportPolicySchema` /
 * `productionHardeningPolicySchema`. Every value has a production-safe
 * default; a deployment needs no new environment variable to run correctly.
 *
 * Server-only: never imported by client components, never exposed to the
 * browser as a value or a response field.
 */
const productionHardeningWebPolicySchema = z.object({
  // Rate limiting (US7) — per-user, per-route-category request ceiling.
  RATE_LIMIT_AI_TASK_PER_MINUTE: z.coerce.number().int().min(1).max(1_000).default(10),
  RATE_LIMIT_IMPORT_PER_MINUTE: z.coerce.number().int().min(1).max(1_000).default(10),
  RATE_LIMIT_EXPORT_PER_MINUTE: z.coerce.number().int().min(1).max(1_000).default(10),
  // Pagination (US8) — hard cap on any caller-requested page size.
  PAGINATION_MAX_PAGE_SIZE: z.coerce.number().int().min(1).max(1_000).default(100),
});

export type ProductionHardeningWebPolicy = z.infer<typeof productionHardeningWebPolicySchema>;

/** Server-only bounds. Browser input cannot override them. */
export function getProductionHardeningPolicy(environment: NodeJS.ProcessEnv = process.env): ProductionHardeningWebPolicy {
  return productionHardeningWebPolicySchema.parse(environment);
}
