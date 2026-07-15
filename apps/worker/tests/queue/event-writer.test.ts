import assert from "node:assert/strict";
import test from "node:test";

import { jobEventKinds } from "../../src/jobs/job-event-writer.js";

test("JobEvent writer exposes only allowlisted queue observations", () => {
  assert.deepEqual(jobEventKinds, ["QUEUE_ENQUEUED", "QUEUE_DELIVERY_PENDING", "QUEUE_RECEIVED", "QUEUE_SKIPPED"]);
});
