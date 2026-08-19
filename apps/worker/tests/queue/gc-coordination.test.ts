import assert from "node:assert/strict";
import test from "node:test";

import { getWorkerConfig } from "../../src/config.js";
import { withAdvisoryLock } from "../../src/queue/gc-coordination.js";
import { createWorkerDatabase } from "../../src/providers/db.js";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL);
// A dedicated test-only key, distinct from GC_LOCK_KEYS, so this test can
// never contend with a real scheduled pass running concurrently.
const TEST_LOCK_KEY = 999_000_001;

test("two worker replicas racing the same scheduled GC pass: only one actually runs; the lock frees once it finishes", { skip: !hasIntegrationDatabase }, async () => {
  const config = getWorkerConfig();
  // Two independent PrismaClient instances — each with its own connection —
  // simulate two separate worker processes contending for the same
  // session-scoped advisory lock.
  const dbA = createWorkerDatabase(config);
  const dbB = createWorkerDatabase(config);
  let releaseSlowWork: (() => void) | undefined;
  const slowWork = new Promise<void>((resolve) => { releaseSlowWork = resolve; });

  try {
    const attemptA = withAdvisoryLock(dbA, TEST_LOCK_KEY, async () => {
      await slowWork;
      return "A-did-it";
    });
    // Let A's transaction actually acquire the lock before B tries.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const attemptB = await withAdvisoryLock(dbB, TEST_LOCK_KEY, async () => "B-did-it");
    assert.deepEqual(attemptB, { ran: false }, "a second replica racing the same pass while the first is still running must be skipped, not queued or double-run");

    releaseSlowWork?.();
    const resultA = await attemptA;
    assert.deepEqual(resultA, { ran: true, result: "A-did-it" });

    // The lock is released (explicitly, inside withAdvisoryLock's finally)
    // once A's transaction commits — a later attempt can now acquire it.
    const attemptC = await withAdvisoryLock(dbB, TEST_LOCK_KEY, async () => "C-did-it");
    assert.deepEqual(attemptC, { ran: true, result: "C-did-it" });
  } finally {
    await dbA.$disconnect();
    await dbB.$disconnect();
  }
});

test("an error inside the locked callback still releases the lock for the next attempt", { skip: !hasIntegrationDatabase }, async () => {
  const config = getWorkerConfig();
  const db = createWorkerDatabase(config);
  try {
    await assert.rejects(() => withAdvisoryLock(db, TEST_LOCK_KEY + 1, async () => { throw new Error("simulated GC pass failure"); }));
    const after = await withAdvisoryLock(db, TEST_LOCK_KEY + 1, async () => "recovered");
    assert.deepEqual(after, { ran: true, result: "recovered" });
  } finally {
    await db.$disconnect();
  }
});
