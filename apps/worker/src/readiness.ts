import { randomBytes } from "node:crypto";

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
import { pollDueAiTasks } from "./queue/ai-poll-scanner.js";

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

    // One identity for this whole worker process, shared by the BullMQ
    // queue-delivery claim (submit) and the scanner-driven AI poll loop
    // below. `job-lock.ts#renewOrReclaimLock` (used only by AI polling) can
    // only renew a lease under the *same* `workerId` that owns it; two
    // independent random ids here would make every poll wait out the full
    // 5-minute claim lease (`job-claim-lock.ts`) before it could even start,
    // instead of the intended ~2s (`POLL_BASE_DELAY_MS`).
    const workerId = `worker-${randomBytes(12).toString("hex")}`;
    const foundationWorker = createFoundationWorker({ config, db, workerId });
    closeOnError = async () => {
      await Promise.allSettled([foundationWorker.close(), queue.close(), connection.quit(), db.$disconnect()]);
    };
    await foundationWorker.worker.waitUntilReady();
    await failExpiredPreparedImports(db).catch(() => undefined);
    const importTimeoutTimer = setInterval(() => { void failExpiredPreparedImports(db); }, 60_000);
    importTimeoutTimer.unref();

    // Scanner-driven AI poll loop — never re-delivered through BullMQ (see
    // specs/020-ai-integration/research.md #1). A short interval keeps
    // POLL_BASE_DELAY_MS (2s) honored promptly.
    await pollDueAiTasks(db, workerId).catch(() => undefined);
    const aiPollTimer = setInterval(() => { void pollDueAiTasks(db, workerId); }, 2_000);
    aiPollTimer.unref();
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
