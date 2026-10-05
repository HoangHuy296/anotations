import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";
import { createPeriodicTask } from "../../src/queue/periodic-task.js";

test("slow maintenance coalesces overlapping ticks and shutdown drains it", async () => {
  let finish!: () => void;
  let passes = 0;
  const task = createPeriodicTask(() => {
    passes++;
    return new Promise<void>((resolve) => { finish = resolve; });
  }, () => assert.fail("unexpected failure"));
  const first = task.run();
  assert.equal(task.run(), first);
  await Promise.resolve();
  assert.equal(passes, 1);
  let stopped = false;
  const stopping = task.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  finish();
  await stopping;
  await task.run();
  assert.equal(passes, 1, "shutdown must prevent another pass");
});

test("maintenance failures are handled and the next pass can recover", async () => {
  let passes = 0;
  let failures = 0;
  const task = createPeriodicTask(() => {
    if (++passes === 1) throw new Error("private provider diagnostic");
    return Promise.resolve();
  }, () => { failures++; });
  await task.run();
  await task.run();
  assert.equal(passes, 2);
  assert.equal(failures, 1);
  await task.stop();
});
