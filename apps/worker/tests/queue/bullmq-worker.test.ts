import assert from "node:assert/strict";
import test from "node:test";

import { getWorkerConfig } from "../../src/config.js";
import { createFoundationWorker } from "../../src/queue/bullmq-worker.js";
import { createWorkerJobFixture, workerQueueIntegrationSkipReason } from "./helpers.js";

test("private worker has graceful close semantics and no HTTP listener", { skip: workerQueueIntegrationSkipReason }, async () => {
  const fixture = await createWorkerJobFixture();
  const runtime = createFoundationWorker({ config: getWorkerConfig(), db: fixture.db });
  try {
    await runtime.worker.waitUntilReady();
    assert.equal("listen" in runtime.worker, false);
    await runtime.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(runtime.connection.status, "end");
  } finally {
    if (runtime.connection.status !== "end") await runtime.close();
    await fixture.cleanup();
  }
});
