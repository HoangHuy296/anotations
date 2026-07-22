import { probeProvider, type ProviderReadiness } from "@fieldframe/domain";

import { getSafeStartupMessage, getWorkerConfig } from "./config.js";
import {
  createWorkerDatabase,
  createWorkerMinio,
  createWorkerQueue,
  ensureBucket,
} from "./providers/index.js";
import { createFoundationWorker } from "./queue/bullmq-worker.js";
import { failExpiredPreparedImports } from "./queue/import-timeout-scanner.js";

export async function startWorkerReadiness() {
  let closeOnError: (() => Promise<void>) | undefined;
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

    closeOnError = async () => {
      await Promise.allSettled([queue.close(), connection.quit(), db.$disconnect()]);
    };
    if (results.some((result) => !result.ready)) {
      await closeOnError();
      throw new Error("Provider readiness failed.");
    }

    const foundationWorker = createFoundationWorker({ config, db });
    closeOnError = async () => {
      await Promise.allSettled([foundationWorker.close(), queue.close(), connection.quit(), db.$disconnect()]);
    };
    await foundationWorker.worker.waitUntilReady();
    await failExpiredPreparedImports(db).catch(() => undefined);
    const importTimeoutTimer = setInterval(() => { void failExpiredPreparedImports(db); }, 60_000);
    importTimeoutTimer.unref();
    await Promise.allSettled([queue.close(), connection.quit()]);

    const shutdown = async () => {
      await closeOnError?.();
      process.exit(0);
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    console.info("Fieldframe worker ready.");
  } catch (error: unknown) {
    await closeOnError?.();
    console.error(getSafeStartupMessage(error));
    process.exitCode = 1;
  }
}
