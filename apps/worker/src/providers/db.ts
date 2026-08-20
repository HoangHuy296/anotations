import { PrismaClient } from "../../../../lib/generated/prisma/client.js";

import type { ProviderConfig } from "@annotationplatform/domain";

export function createWorkerDatabase(config: ProviderConfig) {
  return new PrismaClient({
    datasources: { db: { url: config.DATABASE_URL } },
    log: ["error"],
  });
}
