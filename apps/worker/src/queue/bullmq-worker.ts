import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { randomBytes } from "node:crypto";


import type { ProviderConfig } from "@fieldframe/domain";
import { fieldframeQueueName } from "@fieldframe/queue";
import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";

import { routeQueueDelivery } from "./queue-router.js";


export function createFoundationWorker(input: { config: ProviderConfig; db: PrismaClient }) {
  const workerId = `worker-${randomBytes(12).toString("hex")}`;
  const connection = new Redis({
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

  return {
    worker,
    connection,
    close: async () => {
      await worker.close();
      // BullMQ may close an injected connection while stopping. Avoid a second
      // QUIT command on an already-ended socket during SIGTERM or tests.
      if (connection.status !== "end") {
        await connection.quit().catch(() => undefined);
        // ioredis can resolve QUIT while retaining a ready status when the
        // connection was supplied to BullMQ. Finish the local lifecycle
        // deterministically; this is transport cleanup, never Job state.
        connection.disconnect();
      }
    },
  };
}
