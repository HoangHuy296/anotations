import assert from "node:assert/strict";
import test from "node:test";

import { completeJob } from "../../src/jobs/job-claim-lock.js";
import { writeSafeJobEvent } from "../../src/jobs/job-event-writer.js";

test("aggregate batch event drops arbitrary provider, path, and credential-shaped input", async () => {
  let stored: unknown;
  const db = { jobEvent: { create: async ({ data }: { data: unknown }) => { stored = data; return data; } } };
  await writeSafeJobEvent(db as never, { jobId: "job", kind: "IMPORT_BATCH_COMPLETED", aggregate: { imported: 2, skipped: 1, failed: 0 }, rawError: "forbidden", token: "forbidden", storageKey: "forbidden" } as never);
  assert.deepEqual(stored, { jobId: "job", level: "INFO", message: "IMPORT_BATCH_COMPLETED", data: { imported: 2, skipped: 1, failed: 0 } });
});

test("unsafe completion summaries are rejected before a durable mutation", async () => {
  let mutated = false;
  const db = { job: { updateMany: async () => { mutated = true; return { count: 1 }; } } };
  const result = await completeJob(db as never, { jobId: "job", lockToken: "lock", summary: { imported: 1, token: "forbidden" } });
  assert.deepEqual(result, { kind: "refused" });
  assert.equal(mutated, false);
});
