import { isMediaVerificationEnabled } from "@annotationplatform/domain/media-verification";
import type { ProviderConfig } from "@annotationplatform/domain/provider-config";

import { assertSealedOwnerReady } from "./sealed-namespace.js";

/**
 * A2 readiness for the I-VERIFIER identity. It is required only when media verification is enabled (`MEDIA_VERIFICATION_ENABLED=1`, off by default and unused in
 * this increment), so existing deployments are unaffected. When required, a missing or non-distinct verifier identity fails startup closed: it never falls back to
 * the general worker identity. Config errors name variables only, never values.
 */
export function assertVerifierReadinessWhenEnabled(config: ProviderConfig, env: NodeJS.ProcessEnv = process.env): "NOT_REQUIRED" | "READY" {
  if (!isMediaVerificationEnabled(env)) return "NOT_REQUIRED";
  assertSealedOwnerReady(config, env);
  return "READY";
}
