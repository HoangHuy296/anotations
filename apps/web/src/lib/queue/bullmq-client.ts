import "server-only";

import { readProviderConfig } from "@fieldframe/domain";
import { createQueueTransport } from "@fieldframe/queue";

export function createWebQueue() {
  const config = readProviderConfig();
  const queue = createQueueTransport({ host: config.REDIS_HOST, port: config.REDIS_PORT, password: config.REDIS_PASSWORD, prefix: config.BULLMQ_PREFIX });
  return {
    queue,
    close: async () => { await queue.close(); },
  };
}
