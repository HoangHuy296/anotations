import { probeProvider, type ProviderReadiness } from "@fieldframe/domain";

import { getSafeStartupMessage, getWorkerConfig } from "./config.js";
import {
  createWorkerDatabase,
  createWorkerMinio,
  createWorkerQueue,
  ensureBucket,
} from "./providers/index.js";

export async function startWorkerReadiness() {
  try {
    const config = getWorkerConfig();
    const db = createWorkerDatabase(config);
    const minio = createWorkerMinio(config);
    const { connection, queue } = createWorkerQueue(config);

    const results: ProviderReadiness[] = [
      await probeProvider("postgres", async () => {
        await db.$connect();
      }),
      await probeProvider("minio", async () => {
        await ensureBucket(minio, config.MINIO_BUCKET);
      }),
      await probeProvider("redis", async () => {
        await queue.waitUntilReady();
      }),
    ];

    if (results.some((result) => !result.ready)) {
      await Promise.allSettled([queue.close(), connection.quit(), db.$disconnect()]);
      throw new Error("Provider readiness failed.");
    }

    const shutdown = async () => {
      await Promise.allSettled([queue.close(), connection.quit(), db.$disconnect()]);
      process.exit(0);
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    console.info("Fieldframe worker ready.");
  } catch (error: unknown) {
    console.error(getSafeStartupMessage(error));
    process.exitCode = 1;
  }
}
