import "server-only";

import { readTextSourceLimits, type TextSourceLimits } from "@annotationplatform/domain/text-source-limits";

/**
 * Server-only TEXT source/annotation limits for `apps/web`, sharing the exact
 * defaults/validation as `apps/worker/src/config.ts`'s `getTextSourceLimits`
 * via `packages/domain`. Effective capabilities are returned to the UI, never
 * the raw environment variables (research.md D2).
 */
export function getTextSourceLimits(environment: NodeJS.ProcessEnv = process.env): TextSourceLimits {
  return readTextSourceLimits(environment);
}
