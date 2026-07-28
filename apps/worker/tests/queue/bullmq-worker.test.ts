import assert from "node:assert/strict";
import test from "node:test";
import { Redis } from "ioredis";

import { getWorkerConfig } from "../../src/config.js";
import { createFoundationWorker } from "../../src/queue/bullmq-worker.js";
import { createWorkerJobFixture, workerQueueIntegrationSkipReason } from "./helpers.js";

function waitForEnd(connection: Redis, timeoutMs = 2_000) {
  if (connection.status === "end") return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { connection.off("end", onEnd); reject(new Error("Redis caller connection did not close.")); }, timeoutMs);
    const onEnd = () => { clearTimeout(timeout); resolve(); };
    connection.once("end", onEnd);
  });
}

test("private worker has graceful close semantics and no HTTP listener", { skip: workerQueueIntegrationSkipReason }, async () => {
  const fixture = await createWorkerJobFixture();
  const runtime = createFoundationWorker({ config: getWorkerConfig(), db: fixture.db });
  try {
    await runtime.worker.waitUntilReady();
    assert.equal("listen" in runtime.worker, false);
    assert.equal(runtime.connectionOwnership, "RUNTIME");
    await runtime.close();
    assert.equal(runtime.connection.status, "end");
    await runtime.close();
  } finally {
    if (runtime.connection.status !== "end") await runtime.close();
    await fixture.cleanup();
  }
});

test("caller-owned Redis remains caller-managed after runtime shutdown", { skip: workerQueueIntegrationSkipReason }, async () => {
  const fixture = await createWorkerJobFixture();
  const config = getWorkerConfig();
  const connection = new Redis({ host: config.REDIS_HOST, port: config.REDIS_PORT, password: config.REDIS_PASSWORD, db: config.REDIS_DB, maxRetriesPerRequest: null });
  const runtime = createFoundationWorker({ config, db: fixture.db, connection });
  try {
    await runtime.worker.waitUntilReady();
    assert.equal(runtime.connectionOwnership, "CALLER");
    await runtime.close();
    assert.notEqual(connection.status, "end");
    const ended = waitForEnd(connection);
    await connection.quit();
    await ended;
    assert.equal(connection.status, "end");
  } finally {
    if (connection.status !== "end") connection.disconnect();
    await fixture.cleanup();
  }
});
