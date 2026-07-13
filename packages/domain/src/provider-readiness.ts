export type ProviderReadiness = {
  provider: "postgres" | "minio" | "redis";
  ready: boolean;
};

export async function probeProvider(
  provider: ProviderReadiness["provider"],
  probe: () => Promise<void>,
): Promise<ProviderReadiness> {
  try {
    await probe();
    return { provider, ready: true };
  } catch {
    return { provider, ready: false };
  }
}

export function allProvidersReady(results: ProviderReadiness[]) {
  return results.every((result) => result.ready);
}
