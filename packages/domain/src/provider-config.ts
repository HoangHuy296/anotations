import { z } from "zod";

const aiProviderEndpointSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol)
    && !url.username && !url.password && !url.search && !url.hash;
});

/** Shared server configuration contract; never fall back to a developer's host. */
export function readAiProviderBaseUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const parsed = aiProviderEndpointSchema.safeParse(
    environment.AIOZ_ANNOTATION_SERVICES_URL?.trim()
      || environment.AIOZ_ANNOTATION_SERVICES_BASE_URL?.trim()
      || environment.AIOZ_COMPANY_API_BASE_URL?.trim(),
  );
  if (!parsed.success) throw new ProviderConfigError(["AIOZ_ANNOTATION_SERVICES_URL"]);
  return parsed.data;
}

const providerConfigSchema = z.object({
  DATABASE_URL: z.string().url(),
  MINIO_ENDPOINT: z.string().url(),
  MINIO_ACCESS_KEY: z.string().min(1),
  MINIO_SECRET_KEY: z.string().min(1),
  MINIO_BUCKET: z.string().min(3).max(63),
  MINIO_PUBLIC_ENDPOINT: z.string().url().optional(),
  MINIO_CORS_ALLOWED_ORIGIN: z.string().url().optional(),
  UPLOAD_CAPABILITY_SECRET: z.string().min(32).optional(),
  REDIS_HOST: z.string().min(1),
  REDIS_PORT: z.coerce.number().int().min(1).max(65535),
  REDIS_PASSWORD: z.string().min(1),
  REDIS_DB: z.coerce.number().int().min(0).max(15).default(0),
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

const directUploadConfigSchema = providerConfigSchema.pick({
  MINIO_ENDPOINT: true,
  MINIO_ACCESS_KEY: true,
  MINIO_SECRET_KEY: true,
  MINIO_BUCKET: true,
}).extend({
  MINIO_PUBLIC_ENDPOINT: z.string().url(),
  MINIO_CORS_ALLOWED_ORIGIN: z.string().url(),
  UPLOAD_CAPABILITY_SECRET: z.string().min(32),
});

export type DirectUploadConfig = z.infer<typeof directUploadConfigSchema>;

/** Server-only configuration required to issue constrained direct-transfer capabilities. */
export function readDirectUploadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DirectUploadConfig {
  const parsed = directUploadConfigSchema.safeParse(environment);
  if (parsed.success) return parsed.data;

  const invalidVariables = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
  throw new ProviderConfigError(invalidVariables);
}
