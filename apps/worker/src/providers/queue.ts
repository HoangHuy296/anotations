import { Queue } from "bullmq";
import { Redis } from "ioredis";


import type { ProviderConfig } from "@fieldframe/domain";
import { fieldframeQueueName } from "@fieldframe/queue";

export function createWorkerQueue(config: ProviderConfig) {
  const connection = new Redis({
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    password: config.REDIS_PASSWORD,
    db: config.REDIS_DB,
    maxRetriesPerRequest: null,
  });
  const queue = new Queue(fieldframeQueueName, {
    connection,
    prefix: config.BULLMQ_PREFIX,
  });

  return { connection, queue };
}
