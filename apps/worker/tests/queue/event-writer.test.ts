import assert from "node:assert/strict";
import test from "node:test";

import { jobEventKinds } from "../../src/jobs/job-event-writer.js";

test("JobEvent writer exposes only allowlisted queue and token-free lifecycle observations", () => {
  assert.deepEqual(jobEventKinds, ["QUEUE_ENQUEUED", "QUEUE_DELIVERY_PENDING", "QUEUE_RECEIVED", "QUEUE_SKIPPED", "JOB_CLAIMED", "JOB_HEARTBEAT", "JOB_PROGRESS", "JOB_COMPLETED", "JOB_FAILED", "JOB_CANCELED"]);
});
