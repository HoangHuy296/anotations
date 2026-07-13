import { PrismaClient } from "../../../../lib/generated/prisma/client.js";

import type { ProviderConfig } from "@fieldframe/domain";

export function createWorkerDatabase(config: ProviderConfig) {
  return new PrismaClient({
    datasources: { db: { url: config.DATABASE_URL } },
    log: ["error"],
  });
}
