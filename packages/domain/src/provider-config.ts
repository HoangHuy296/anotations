import { z } from "zod";

const providerConfigSchema = z.object({
  DATABASE_URL: z.string().url(),
  MINIO_ENDPOINT: z.string().url(),
  MINIO_ACCESS_KEY: z.string().min(1),
  MINIO_SECRET_KEY: z.string().min(1),
  MINIO_BUCKET: z.string().min(3).max(63),
  REDIS_HOST: z.string().min(1),
  REDIS_PORT: z.coerce.number().int().min(1).max(65535),
  REDIS_PASSWORD: z.string().min(1),
  BULLMQ_PREFIX: z.string().min(1),
});

export type ProviderConfig = z.infer<typeof providerConfigSchema>;

export class ProviderConfigError extends Error {
  readonly invalidVariables: string[];

  constructor(invalidVariables: string[]) {
    super(
      `Required provider configuration is missing or invalid: ${invalidVariables.join(", ")}.`,
    );
    this.name = "ProviderConfigError";
    this.invalidVariables = invalidVariables;
  }
}

export function readProviderConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ProviderConfig {
  const parsed = providerConfigSchema.safeParse(environment);
  if (parsed.success) return parsed.data;

  const invalidVariables = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
  throw new ProviderConfigError(invalidVariables);
}
