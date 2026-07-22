import assert from "node:assert/strict";
import test from "node:test";

import { jobFailureMessage, jobProgressPercent, shouldPollJob } from "@/lib/jobs/job-progress-view";
import { sanitizeJobSummary } from "@/lib/jobs/safe-job-status";

test("progress helpers clamp durable values and derive totals", () => {
  assert.equal(jobProgressPercent({ progress: 145, totalItems: 10, processedItems: 1 }), 100);
  assert.equal(jobProgressPercent({ progress: null, totalItems: 4, processedItems: 1 }), 25);
  assert.equal(jobProgressPercent({ progress: null, totalItems: null, processedItems: 0 }), null);
});

test("polling stops at terminal statuses and while the page is hidden", () => {
  assert.equal(shouldPollJob("RUNNING"), true);
  assert.equal(shouldPollJob("CANCELING"), true);
  assert.equal(shouldPollJob("FAILED"), false);
  assert.equal(shouldPollJob("QUEUED", false), false);
});

test("failure panel uses only the safe summary message", () => {
  assert.equal(jobFailureMessage({ status: "FAILED", summary: { message: "Export could not complete." } }), "Export could not complete.");
  assert.equal(jobFailureMessage({ status: "CANCELED", summary: null }), "This job was canceled.");
  assert.equal(jobFailureMessage({ status: "COMPLETED", summary: { message: "ignore" } }), null);
});

test("safe summary is allowlisted and rejects raw diagnostic JSON", () => {
  assert.deepEqual(sanitizeJobSummary({ message: "Export did not complete.", outcome: "failed", resultCount: 2 }), { message: "Export did not complete.", outcome: "failed", resultCount: 2 });
  assert.equal(sanitizeJobSummary({ message: "safe", rawError: "must-not-leak" }), null);
  assert.equal(sanitizeJobSummary({ nested: { token: "must-not-leak" } }), null);
});
