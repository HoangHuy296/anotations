import "server-only";

import { ProviderConfigError, probeProvider } from "@annotationplatform/domain";

import { getWebProviders } from "@/lib/providers";

export async function getWebReadiness() {
  try {
    const { db } = getWebProviders();
    const postgres = await probeProvider("postgres", async () => {
      await db.$connect();
    });

    return postgres.ready ? "ready" : "not_ready";
  } catch (error: unknown) {
    if (error instanceof ProviderConfigError) return "not_ready";
    return "not_ready";
  }
}
