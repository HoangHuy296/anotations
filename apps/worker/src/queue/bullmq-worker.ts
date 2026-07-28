import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { randomBytes } from "node:crypto";


import type { ProviderConfig } from "@fieldframe/domain";
import { fieldframeQueueName } from "@fieldframe/queue";
import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";

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

export function createFoundationWorker(input: { config: ProviderConfig; db: PrismaClient; connection?: Redis }) {
  const workerId = `worker-${randomBytes(12).toString("hex")}`;
  const ownsConnection = input.connection === undefined;
  const connection = input.connection ?? new Redis({
    host: input.config.REDIS_HOST,
    port: input.config.REDIS_PORT,
    password: input.config.REDIS_PASSWORD,
    db: input.config.REDIS_DB,
    maxRetriesPerRequest: null,
  });
  const worker = new Worker(
    fieldframeQueueName,
    async (delivery) => routeQueueDelivery({ db: input.db, payload: delivery.data, workerId }),
    { connection, prefix: input.config.BULLMQ_PREFIX },
  );

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
