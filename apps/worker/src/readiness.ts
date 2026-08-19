import { randomBytes } from "node:crypto";

import { probeProvider, type ProviderReadiness } from "@fieldframe/domain";

import { getProductionHardeningPolicy, getSafeStartupMessage, getWorkerConfig } from "./config.js";
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
        await ensureTempUploadLifecyclePolicy(minio, config.MINIO_BUCKET, hardening.MINIO_TEMP_UPLOAD_LIFECYCLE_DAYS).catch((error: unknown) => {
          console.warn("MinIO temp-upload lifecycle policy could not be applied (non-fatal):", error instanceof Error ? error.message : error);
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
    await failExpiredPreparedImports(db).catch(() => undefined);
    const importTimeoutTimer = setInterval(() => { void failExpiredPreparedImports(db); }, 60_000);
    importTimeoutTimer.unref();

    // Scanner-driven AI poll loop — never re-delivered through BullMQ (see
    // specs/020-ai-integration/research.md #1). A short interval keeps
    // POLL_BASE_DELAY_MS (2s) honored promptly.
    await pollDueAiTasks(db, workerId).catch(() => undefined);
    const aiPollTimer = setInterval(() => { void pollDueAiTasks(db, workerId); }, 2_000);
    aiPollTimer.unref();

    // 021-production-hardening-garbage-collection, User Story 1/2.
    //
    // `queue`/`connection` (created above only for the one-shot Redis
    // readiness probe) are kept open for the rest of the process's life
    // instead of being closed here, so the recovery scanner has a live
    // BullMQ client to redeliver a Job through — no second Redis connection
    // is opened for this. They are closed only in `closeOnError`/`shutdown`
    // below, alongside every other long-lived resource this process holds.
    const redeliverExistingJob = createWorkerJobRedeliverer(db, queue);

    // Recovery scanner: Jobs whose durable record exists but were never
    // successfully delivered to BullMQ (a Redis outage at enqueue time, or a
    // worker that crashed between creating the Job and confirming delivery).
    // `runPendingJobRecovery` (recovery-scanner.ts) was implemented and
    // tested in an earlier phase but never scheduled until now.
    await runPendingJobRecovery({ db, redeliverExistingJob }).catch(() => undefined);
    const recoveryTimer = setInterval(() => { void runPendingJobRecovery({ db, redeliverExistingJob }); }, 60_000);
    recoveryTimer.unref();

    // Stale-`RUNNING` detector: a worker that claimed a Job and then crashed
    // or lost connectivity (lease expired) — retried in place under budget,
    // dead-lettered once exhausted. Independent of, and complementary to,
    // the lease-based detector: a Job that has simply run far too long,
    // regardless of whether its lease is still being renewed.
    const runStaleJobPass = () => {
      void recoverExpiredLeaseJobs({ db, leaseGraceMs: hardening.JOB_RECOVERY_LEASE_GRACE_MS });
      void failRunawayJobs({ db, maxRuntimeMs: hardening.JOB_MAX_RUNTIME_MS });
    };
    runStaleJobPass();
    const staleJobTimer = setInterval(runStaleJobPass, 60_000);
    staleJobTimer.unref();

    // MinIO orphan scanner + temp-upload cleanup (User Story 4). Both are
    // heavier, full-prefix-listing passes — scheduled far less frequently
    // than the lightweight per-row scanners above — and both are
    // cross-worker-replica-coordinated (gc-coordination.ts's advisory
    // lock), so running several worker replicas never causes two of them
    // to run the same pass at once. `MINIO_ORPHAN_SCAN_DRY_RUN` (T003,
    // default true) governs whether the scheduled scan actually deletes
    // anything — an operator must explicitly opt in to live deletion.
    const runOrphanScanPass = () => { void runScheduledOrphanScan({ db, minio, bucket: config.MINIO_BUCKET, dryRun: hardening.MINIO_ORPHAN_SCAN_DRY_RUN, gracePeriodMs: hardening.MINIO_ORPHAN_GRACE_PERIOD_MS }); };
    runOrphanScanPass();
    const orphanScanTimer = setInterval(runOrphanScanPass, 60 * 60_000);
    orphanScanTimer.unref();

    const runTempUploadCleanupPass = () => { void runScheduledTempUploadCleanup({ db, minio, bucket: config.MINIO_BUCKET, dryRun: hardening.MINIO_ORPHAN_SCAN_DRY_RUN, gracePeriodMs: hardening.TEMP_UPLOAD_RETENTION_MS }); };
    runTempUploadCleanupPass();
    const tempUploadCleanupTimer = setInterval(runTempUploadCleanupPass, 30 * 60_000);
    tempUploadCleanupTimer.unref();

    // JobEvent retention (User Story 5) — deletes only, never touches an
    // active Job's events regardless of age (FR-036), coordinated the same
    // way as the two passes above so multiple worker replicas never run
    // overlapping batches against each other.
    const runJobEventRetentionPass = () => { void runScheduledJobEventRetention({ db, retentionDays: hardening.JOB_EVENT_RETENTION_DAYS, batchSize: hardening.JOB_EVENT_CLEANUP_BATCH_SIZE }); };
    runJobEventRetentionPass();
    const jobEventRetentionTimer = setInterval(runJobEventRetentionPass, 60 * 60_000);
    jobEventRetentionTimer.unref();

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
