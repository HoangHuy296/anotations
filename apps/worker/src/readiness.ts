import { randomBytes } from "node:crypto";
import { createPeriodicTask } from "./queue/periodic-task.js";

import { probeProvider, type ProviderReadiness } from "@annotationplatform/domain";

import { getProductionHardeningPolicy, getSafeStartupMessage, getTextSourceLimits, getWorkerConfig } from "./config.js";
import {
  createWorkerDatabase,
  createWorkerMinio,
  createWorkerQueue,
  ensureBucket,
  ensureTempUploadLifecyclePolicy,
} from "./providers/index.js";
import { createFoundationWorker } from "./queue/bullmq-worker.js";
import { failExpiredPreparedImports } from "./queue/import-timeout-scanner.js";
import { pollDueAiTasks } from "./queue/ai-poll-scanner.js";
import { runScheduledJobEventRetention } from "./queue/jobevent-retention.js";
import { runScheduledOrphanScan } from "./queue/minio-orphan-scanner.js";
import { runPendingJobRecovery } from "./queue/recovery-scanner.js";
import { createWorkerJobRedeliverer } from "./queue/redeliver-job.js";
import { failRunawayJobs, recoverExpiredLeaseJobs } from "./queue/stale-job-detector.js";
import { runScheduledTempUploadCleanup } from "./queue/temp-upload-cleanup.js";

export async function startWorkerReadiness() {
  let closeOnError: (() => Promise<void>) | undefined;
  try {
    const config = getWorkerConfig();
    const hardening = getProductionHardeningPolicy();
    // Malformed TEXT_WORKSPACE_MAX_* overrides must fail startup rather than
    // surface as a confusing failure the first time TEXT_SOURCE_PREPARE runs.
    getTextSourceLimits();
    const db = createWorkerDatabase(config);
    const minio = createWorkerMinio(config);
    const { connection, queue } = createWorkerQueue(config);

    const results: ProviderReadiness[] = [
      await probeProvider("postgres", async () => {
        await db.$connect();
      }),
      await probeProvider("minio", async () => {
        await ensureBucket(minio, config.MINIO_BUCKET);
        // Secondary GC safety net (021-...), not a readiness requirement —
        // never blocks startup if the deployment lacks permission to set a
        // bucket lifecycle policy. Idempotent, prefix-scoped only to the
        // two known temp/staging prefixes (see the function's own doc
        // comment) — never touches a permanent asset prefix.
        await ensureTempUploadLifecyclePolicy(minio, config.MINIO_BUCKET, hardening.MINIO_TEMP_UPLOAD_LIFECYCLE_DAYS).catch(() => {
          console.warn("MinIO temp-upload lifecycle policy could not be applied (non-fatal).");
        });
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
    const maintenance: ReturnType<typeof createPeriodicTask>[] = [];
    const schedule = (name: string, intervalMs: number, operation: () => Promise<unknown>) => {
      // Only a fixed task name is logged; provider/database errors may contain secrets.
      const task = createPeriodicTask(operation, () => console.warn(`Worker maintenance failed: ${name}.`));
      maintenance.push(task);
      task.start(intervalMs);
      void task.run();
    };
    const closeResources = closeOnError;
    closeOnError = async () => {
      // Drain scanner work before closing its database and queue connections.
      await Promise.all(maintenance.map((task) => task.stop()));
      await closeResources();
    };

    schedule("import timeout", 60_000, () => failExpiredPreparedImports(db));
    schedule("AI polling", 2_000, () => pollDueAiTasks(db, workerId));

    // PostgreSQL owns recovery; BullMQ only redelivers the durable jobId.
    const redeliverExistingJob = createWorkerJobRedeliverer(db, queue);
    schedule("pending delivery recovery", 60_000, () => runPendingJobRecovery({ db, redeliverExistingJob }));
    schedule("expired lease recovery", 60_000, () => recoverExpiredLeaseJobs({ db, leaseGraceMs: hardening.JOB_RECOVERY_LEASE_GRACE_MS }));
    schedule("runaway job detection", 60_000, () => failRunawayJobs({ db, maxRuntimeMs: hardening.JOB_MAX_RUNTIME_MS }));

    // Cross-replica GC coordination remains inside each scanner. The local
    // scheduler prevents overlap and catches failures between interval ticks.
    schedule("orphan scan", 60 * 60_000, () => runScheduledOrphanScan({ db, minio, bucket: config.MINIO_BUCKET, dryRun: hardening.MINIO_ORPHAN_SCAN_DRY_RUN, gracePeriodMs: hardening.MINIO_ORPHAN_GRACE_PERIOD_MS }));
    schedule("temp upload cleanup", 30 * 60_000, () => runScheduledTempUploadCleanup({ db, minio, bucket: config.MINIO_BUCKET, dryRun: hardening.MINIO_ORPHAN_SCAN_DRY_RUN, gracePeriodMs: hardening.TEMP_UPLOAD_RETENTION_MS }));
    schedule("job event retention", 60 * 60_000, () => runScheduledJobEventRetention({ db, retentionDays: hardening.JOB_EVENT_RETENTION_DAYS, batchSize: hardening.JOB_EVENT_CLEANUP_BATCH_SIZE }));

    const shutdown = async () => {
      await closeOnError?.();
      process.exit(0);
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    console.info("Annotation Platform worker ready.");
  } catch (error: unknown) {
    await closeOnError?.();
    console.error(getSafeStartupMessage(error));
    process.exitCode = 1;
  }
}
