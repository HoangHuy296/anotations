import { z } from "zod";

/**
 * Central TEXT source/annotation limits. Web and worker call
 * `readTextSourceLimits(env)`, passing their own environment record, instead
 * of duplicating defaults or parsing these variables themselves.
 */

export const TEXT_WORKSPACE_MAX_SOURCE_BYTES_ENV = "TEXT_WORKSPACE_MAX_SOURCE_BYTES" as const;
export const TEXT_WORKSPACE_MAX_CODE_UNITS_ENV = "TEXT_WORKSPACE_MAX_CODE_UNITS" as const;
export const TEXT_WORKSPACE_MAX_ANNOTATIONS_ENV = "TEXT_WORKSPACE_MAX_ANNOTATIONS" as const;

export const TEXT_SOURCE_LIMIT_DEFAULTS = Object.freeze({
  maxSourceBytes: 1_048_576,
  maxCodeUnits: 100_000,
  maxAnnotations: 5000,
});

const textSourceLimitsSchema = z.object({
  maxSourceBytes: z.number().int().positive().safe(),
  maxCodeUnits: z.number().int().positive().safe(),
  maxAnnotations: z.number().int().positive().safe(),
});

export type TextSourceLimits = z.infer<typeof textSourceLimitsSchema>;

function parsePositiveIntEnv(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: expected a positive integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/** Pure: takes an env-like record so callers control the source (the runtime environment or a fixture). */
export function readTextSourceLimits(env: Readonly<Record<string, string | undefined>>): TextSourceLimits {
  return textSourceLimitsSchema.parse({
    maxSourceBytes: parsePositiveIntEnv(
      env[TEXT_WORKSPACE_MAX_SOURCE_BYTES_ENV],
      TEXT_SOURCE_LIMIT_DEFAULTS.maxSourceBytes,
      TEXT_WORKSPACE_MAX_SOURCE_BYTES_ENV,
    ),
    maxCodeUnits: parsePositiveIntEnv(
      env[TEXT_WORKSPACE_MAX_CODE_UNITS_ENV],
      TEXT_SOURCE_LIMIT_DEFAULTS.maxCodeUnits,
      TEXT_WORKSPACE_MAX_CODE_UNITS_ENV,
    ),
    maxAnnotations: parsePositiveIntEnv(
      env[TEXT_WORKSPACE_MAX_ANNOTATIONS_ENV],
      TEXT_SOURCE_LIMIT_DEFAULTS.maxAnnotations,
      TEXT_WORKSPACE_MAX_ANNOTATIONS_ENV,
    ),
  });
}
