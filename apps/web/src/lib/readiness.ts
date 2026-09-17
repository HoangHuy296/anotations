import "server-only";

import { ProviderConfigError, probeProvider } from "@annotationplatform/domain";

import { getWebProviders } from "@/lib/providers";
import { getTextSourceLimits } from "@/lib/config/text-source-limits";

export async function getWebReadiness() {
  try {
    const { db } = getWebProviders();
    const postgres = await probeProvider("postgres", async () => {
      await db.$connect();
    });

    // Malformed TEXT_WORKSPACE_MAX_* overrides must fail readiness rather
    // than surface as a confusing 500 on first workspace request.
    getTextSourceLimits();

    return postgres.ready ? "ready" : "not_ready";
  } catch (error: unknown) {
    if (error instanceof ProviderConfigError) return "not_ready";
    return "not_ready";
  }
}
