import assert from "node:assert/strict";
import test from "node:test";

import { repositoryImportProgressPath, repositoryImportProgressState } from "@/lib/repository-import/progress-state";
import { shouldPollJob } from "@/lib/jobs/job-progress-view";

test("repository import progress derives pending, active, and terminal UI states only from the safe Job status projection", () => {
  const pending = repositoryImportProgressState({ status: "QUEUED", stage: null });
  assert.equal(pending.kind, "pending");
  assert.match(pending.message, /queued and waiting for a worker/i);
  assert.equal(shouldPollJob("QUEUED", true), true);

  const active = repositoryImportProgressState({ status: "RUNNING", stage: "SCANNING_FILES" });
  assert.equal(active.kind, "active");
  assert.equal(shouldPollJob("RUNNING", true), true);

  const terminal = repositoryImportProgressState({ status: "COMPLETED", stage: null });
  assert.equal(terminal.kind, "terminal");
  assert.equal(shouldPollJob("COMPLETED", true), false);
});

test("repository retry stays on the Dataset-scoped import progress route", () => {
  assert.equal(repositoryImportProgressPath("dataset-1", "successor-1"), "/datasets/dataset-1/imports/successor-1");
});
