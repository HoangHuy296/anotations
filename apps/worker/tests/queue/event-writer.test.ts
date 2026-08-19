import assert from "node:assert/strict";
import test from "node:test";

import { jobEventKinds } from "../../src/jobs/job-event-writer.js";

test("JobEvent writer exposes only allowlisted queue and token-free lifecycle observations", () => {
  assert.deepEqual(jobEventKinds, [
    "QUEUE_ENQUEUED", "QUEUE_DELIVERY_PENDING", "QUEUE_RECEIVED", "QUEUE_SKIPPED",
    "JOB_CLAIMED", "JOB_HEARTBEAT", "JOB_PROGRESS", "IMPORT_BATCH_COMPLETED",
    "JOB_COMPLETED", "JOB_FAILED", "JOB_CANCELED",
    // 021-production-hardening-garbage-collection additions.
    "JOB_RECOVERED", "JOB_STALE_TIMEOUT", "JOB_DEAD_LETTERED",
    "MINIO_ORPHAN_DETECTED", "MINIO_ORPHAN_DELETED",
    "ASSET_STORAGE_CLEANED", "DATASET_STORAGE_CLEANED", "TEMP_UPLOAD_CLEANED",
  ]);
});
