import "server-only";

import { readProviderConfig } from "@fieldframe/domain";
import { createQueueTransport } from "@fieldframe/queue";

export function createWebQueue() {
  const config = readProviderConfig();
  // Browser request handlers enqueue only after their durable PostgreSQL Job
  // transaction commits. Bound the producer's Redis failure so an unavailable
  // transport returns the recoverable QUEUED/pending-delivery response instead
  // of keeping a request open indefinitely. Workers and recovery keep their
  // normal long-lived transport behavior.
  const queue = createQueueTransport({
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    password: config.REDIS_PASSWORD,
    db: config.REDIS_DB,
    prefix: config.BULLMQ_PREFIX,
    failFast: true,
  });
  return {
    queue,
    close: async () => { await queue.close(); },
  };
}
