import {
  ProviderConfigError,
  readProviderConfig,
  type ProviderConfig,
} from "@fieldframe/domain";
import { z } from "zod";

export function getWorkerConfig(): ProviderConfig {
  return readProviderConfig();
}

export function getSafeStartupMessage(error: unknown) {
  if (error instanceof ProviderConfigError) return error.message;
  return "Worker provider readiness could not be established.";
}

const repositoryImportPolicySchema = z.object({
  REPOSITORY_IMPORT_BATCH_SIZE: z.coerce.number().int().min(50).max(200).default(100),
  REPOSITORY_IMPORT_MAX_FILE_BYTES: z.coerce.number().int().min(1).max(100 * 1024 * 1024).default(100 * 1024 * 1024),
  REPOSITORY_IMPORT_MAX_TOTAL_BYTES: z.coerce.number().int().min(1).max(5 * 1024 * 1024 * 1024).default(5 * 1024 * 1024 * 1024),
  REPOSITORY_IMPORT_MAX_FILES: z.coerce.number().int().min(1).max(10_000).default(10_000),
});

/** Server-only bounds. Browser input and durable Job input cannot override them. */
export function getRepositoryImportPolicy(environment: NodeJS.ProcessEnv = process.env) {
  return repositoryImportPolicySchema.parse(environment);
}

/**
 * Production-hardening thresholds (021-production-hardening-garbage-collection).
 * Every value has a production-safe default so a deployment needs no new
 * environment variable to run correctly; each is independently overridable.
 * Server-only, same "browser/durable input cannot override" guarantee as
 * `repositoryImportPolicySchema` above.
 */
const productionHardeningPolicySchema = z.object({
  // Stale-RUNNING recovery (specs/021.../research.md decision 1).
  JOB_RECOVERY_LEASE_GRACE_MS: z.coerce.number().int().min(1_000).max(30 * 60_000).default(60_000),
  JOB_MAX_RUNTIME_MS: z.coerce.number().int().min(60_000).max(24 * 60 * 60_000).default(60 * 60_000),
  // BullMQ stalled-job handling (decision 3).
  JOB_LOCK_DURATION_MS: z.coerce.number().int().min(5_000).max(10 * 60_000).default(30_000),
  JOB_STALLED_INTERVAL_MS: z.coerce.number().int().min(5_000).max(10 * 60_000).default(30_000),
  JOB_MAX_STALLED_COUNT: z.coerce.number().int().min(1).max(10).default(1),
  // JobEvent retention (US5).
  JOB_EVENT_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  JOB_EVENT_CLEANUP_BATCH_SIZE: z.coerce.number().int().min(50).max(5_000).default(500),
  // MinIO orphan scanning / temp-upload cleanup (US4, decision 5).
  MINIO_ORPHAN_GRACE_PERIOD_MS: z.coerce.number().int().min(60_000).max(30 * 24 * 60 * 60_000).default(24 * 60 * 60_000),
  MINIO_ORPHAN_SCAN_DRY_RUN: z.coerce.boolean().default(true),
  TEMP_UPLOAD_RETENTION_MS: z.coerce.number().int().min(60_000).max(30 * 24 * 60 * 60_000).default(24 * 60 * 60_000),
  // MinIO lifecycle policy (secondary safety net — see providers/minio.ts's
  // ensureTempUploadLifecyclePolicy doc comment). Day-granularity only;
  // deliberately longer than TEMP_UPLOAD_RETENTION_MS's default (1 day).
  MINIO_TEMP_UPLOAD_LIFECYCLE_DAYS: z.coerce.number().int().min(1).max(90).default(7),
});

export type ProductionHardeningPolicy = z.infer<typeof productionHardeningPolicySchema>;

/** Server-only bounds. Same convention as `getRepositoryImportPolicy`. */
export function getProductionHardeningPolicy(environment: NodeJS.ProcessEnv = process.env): ProductionHardeningPolicy {
  return productionHardeningPolicySchema.parse(environment);
}

const aiozCompanyProviderConfigSchema = z.object({
  AIOZ_COMPANY_API_BASE_URL: z.string().url(),
  AIOZ_COMPANY_API_KEY: z.string().min(1),
});

export type AiozCompanyProviderConfig = z.infer<typeof aiozCompanyProviderConfigSchema>;

/**
 * Worker-only credentials for the external AIOZ-company AI provider. Never
 * read from apps/web; never placed in AiTask/Job input, output, or a queue
 * payload. Consumed only by apps/worker/src/providers/ai/aioz-company.provider.ts.
 */
export function getAiozCompanyProviderConfig(environment: NodeJS.ProcessEnv = process.env): AiozCompanyProviderConfig {
  return aiozCompanyProviderConfigSchema.parse(environment);
}
