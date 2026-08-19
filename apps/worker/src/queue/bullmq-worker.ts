import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { randomBytes } from "node:crypto";


import type { ProviderConfig } from "@fieldframe/domain";
import { logRedisEvent } from "@fieldframe/domain";
import { fieldframeQueueName } from "@fieldframe/queue";
import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";

import { getProductionHardeningPolicy } from "../config.js";
import { routeQueueDelivery } from "./queue-router.js";


export type RedisConnectionOwnership = "RUNTIME" | "CALLER";

async function waitForRedisEnd(connection: Redis, timeoutMs = 2_000) {
  if (connection.status === "end") return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      connection.off("end", onEnd);
      reject(new Error("Runtime-owned Redis connection did not close."));
    }, timeoutMs);
    const onEnd = () => { clearTimeout(timeout); resolve(); };
    connection.once("end", onEnd);
  });
}

export function createFoundationWorker(input: {
  config: ProviderConfig;
  db: PrismaClient;
  connection?: Redis;
  workerId?: string;
  /**
   * 021-production-hardening-garbage-collection: BullMQ's own stalled-job
   * detection (FR-019). BullMQ ships enabled by default even unconfigured
   * (`lockDuration`/`stalledInterval` default to 30s, `maxStalledCount` to
   * 1) — these overrides make the thresholds explicit and tunable via
   * `getProductionHardeningPolicy()` rather than relying on BullMQ's silent
   * built-in defaults, and let tests exercise a real stall on a short,
   * deterministic timescale. A stalled redelivery reaches the same
   * `routeQueueDelivery` → `claimJob` guard as any other delivery, so
   * whether a Job is still `RUNNING` (not yet `QUEUED`/`RETRYING`) is what
   * prevents it from being processed twice — not this configuration alone.
   */
  lockDuration?: number;
  stalledInterval?: number;
  maxStalledCount?: number;
}) {
  // `job-lock.ts#renewOrReclaimLock`'s scanner-driven re-entry (used only by
  // AI polling) only ever renews a lease for the *same* `workerId` that
  // currently owns it, or reclaims one whose lease has already expired
  // (`job-claim-lock.ts#claimJob`'s claim at submit time -- 5 minutes). A
  // caller that later polls under a *different* random `workerId` than the
  // one this queue-delivery claim used can't renew that lease, and has to
  // wait out the full 5 minutes for it to expire before it can reclaim it —
  // `readiness.ts` passes its own `aiPollWorkerId` in here for exactly this
  // reason, so one worker process's queue-claim identity and its AI-poll
  // identity are the same and polling can pick a submitted task up promptly.
  const workerId = input.workerId ?? `worker-${randomBytes(12).toString("hex")}`;
  const ownsConnection = input.connection === undefined;
  const connection = input.connection ?? new Redis({
    host: input.config.REDIS_HOST,
    port: input.config.REDIS_PORT,
    password: input.config.REDIS_PASSWORD,
    db: input.config.REDIS_DB,
    maxRetriesPerRequest: null,
  });
  const hardening = getProductionHardeningPolicy();
  const worker = new Worker(
    fieldframeQueueName,
    async (delivery) => routeQueueDelivery({ db: input.db, payload: delivery.data, workerId }),
    {
      connection,
      prefix: input.config.BULLMQ_PREFIX,
      lockDuration: input.lockDuration ?? hardening.JOB_LOCK_DURATION_MS,
      stalledInterval: input.stalledInterval ?? hardening.JOB_STALLED_INTERVAL_MS,
      maxStalledCount: input.maxStalledCount ?? hardening.JOB_MAX_STALLED_COUNT,
    },
  );

  // 021-production-hardening-garbage-collection (FR-017/FR-047): never
  // swallow a Redis/queue connection failure or reconnect — the durable Job
  // record is unaffected either way (Postgres remains authoritative), but an
  // operator must be able to see this happening.
  worker.on("error", (error) => {
    logRedisEvent("WORKER_ERROR", { detail: error instanceof Error ? error.message : "unknown error" }, "error");
  });
  connection.on("error", (error) => {
    logRedisEvent("CONNECTION_ERROR", { detail: error instanceof Error ? error.message : "unknown error" }, "error");
  });
  connection.on("reconnecting", () => {
    logRedisEvent("RECONNECTING");
  });
  connection.on("ready", () => {
    logRedisEvent("READY");
  });

  let closing: Promise<void> | null = null;

  return {
    worker,
    connection,
    connectionOwnership: ownsConnection ? "RUNTIME" as const : "CALLER" as const,
    close: () => {
      if (closing) return closing;
      closing = (async () => {
        // Stop consumption first; BullMQ closes its internal resources before
        // the base connection is touched.
      await worker.close();
        if (!ownsConnection || connection.status === "end") return;
        const ended = waitForRedisEnd(connection);
        try {
          await connection.quit();
        } catch {
          connection.disconnect();
        }
        // A failed QUIT may leave a live socket; force only runtime-owned
        // transport down and still wait for the terminal ioredis event.
        if (String(connection.status) !== "end") connection.disconnect();
        await ended;
      })();
      return closing;
    },
  };
}
