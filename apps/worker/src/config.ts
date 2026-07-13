import {
  ProviderConfigError,
  readProviderConfig,
  type ProviderConfig,
} from "@fieldframe/domain";

export function getWorkerConfig(): ProviderConfig {
  return readProviderConfig();
}

export function getSafeStartupMessage(error: unknown) {
  if (error instanceof ProviderConfigError) return error.message;
  return "Worker provider readiness could not be established.";
}
