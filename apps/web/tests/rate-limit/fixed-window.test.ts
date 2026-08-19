import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { Redis } from "ioredis";

import { readProviderConfig } from "@fieldframe/domain";

import { checkRateLimit } from "@/lib/rate-limit/fixed-window";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL);

// A dedicated connection per test run — key namespace is
// `ratelimit:{randomUUID}:...`, so this can never collide with any other
// Redis-resident state (BullMQ queues use an entirely different key
// prefix) regardless of which Redis instance it runs against.
const connection = hasIntegrationDatabase ? new Redis({
  host: readProviderConfig().REDIS_HOST,
  port: readProviderConfig().REDIS_PORT,
  password: readProviderConfig().REDIS_PASSWORD,
  db: readProviderConfig().REDIS_DB,
  maxRetriesPerRequest: 1,
}) : undefined;

after(async () => { await connection?.quit().catch(() => undefined); });

test("N requests within the window succeed; the (N+1)th is rejected", { skip: !hasIntegrationDatabase }, async () => {
  const userId = randomUUID();
  const limit = 3;
  for (let i = 0; i < limit; i += 1) {
    const result = await checkRateLimit({ userId, category: "ai-task", limit, windowSeconds: 60, connection });
    assert.deepEqual(result, { allowed: true }, `request ${i + 1} of ${limit} must be allowed`);
  }
  const rejected = await checkRateLimit({ userId, category: "ai-task", limit, windowSeconds: 60, connection });
  assert.equal(rejected.allowed, false);
  if (!rejected.allowed) {
    assert.ok(rejected.retryAfterSeconds > 0);
    assert.ok(rejected.retryAfterSeconds <= 60);
  }
});

test("a request in the next window succeeds again", { skip: !hasIntegrationDatabase }, async () => {
  const userId = randomUUID();
  const limit = 1;
  const windowSeconds = 1;
  const first = await checkRateLimit({ userId, category: "ai-task", limit, windowSeconds, connection });
  assert.deepEqual(first, { allowed: true });
  const secondSameWindow = await checkRateLimit({ userId, category: "ai-task", limit, windowSeconds, connection });
  assert.equal(secondSameWindow.allowed, false);

  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const nextWindow = await checkRateLimit({ userId, category: "ai-task", limit, windowSeconds, connection });
  assert.deepEqual(nextWindow, { allowed: true });
});

test("two different users never share a counter", { skip: !hasIntegrationDatabase }, async () => {
  const userA = randomUUID();
  const userB = randomUUID();
  const limit = 1;
  const first = await checkRateLimit({ userId: userA, category: "ai-task", limit, windowSeconds: 60, connection });
  assert.deepEqual(first, { allowed: true });
  const secondUserFirstRequest = await checkRateLimit({ userId: userB, category: "ai-task", limit, windowSeconds: 60, connection });
  assert.deepEqual(secondUserFirstRequest, { allowed: true }, "a different user's counter must be independent");
});

test("different categories for the same user never share a counter", { skip: !hasIntegrationDatabase }, async () => {
  const userId = randomUUID();
  const limit = 1;
  const aiTask = await checkRateLimit({ userId, category: "ai-task", limit, windowSeconds: 60, connection });
  assert.deepEqual(aiTask, { allowed: true });
  const exportCategory = await checkRateLimit({ userId, category: "export", limit, windowSeconds: 60, connection });
  assert.deepEqual(exportCategory, { allowed: true }, "a different category for the same user must be independent");
});

test("a Redis failure fails open (allowed) and is not silently swallowed", { skip: !hasIntegrationDatabase }, async () => {
  // A connection pointed at an unreachable port, with bounded retries, so
  // this resolves quickly into checkRateLimit's catch branch rather than
  // hanging.
  const unreachable = new Redis({ host: "127.0.0.1", port: 1, maxRetriesPerRequest: 1, retryStrategy: () => null, lazyConnect: true });
  unreachable.on("error", () => undefined); // expected in this test; checkRateLimit's own catch is what's under test.
  try {
    const result = await checkRateLimit({ userId: randomUUID(), category: "ai-task", limit: 1, windowSeconds: 60, connection: unreachable });
    assert.deepEqual(result, { allowed: true }, "a Redis outage must never block legitimate job creation");
  } finally {
    unreachable.disconnect();
  }
});
