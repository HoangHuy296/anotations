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
