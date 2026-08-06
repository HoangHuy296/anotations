import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";

import { runBoundedMediaProcess } from "../../src/media/subprocess.js";
import { createJobTempWorkspace, withJobTempWorkspace } from "../../src/media/temp-workspace.js";

test("bounded worker subprocess completes without a shell", async () => {
  const result = await runBoundedMediaProcess({
    command: "/bin/echo",
    args: ["-n", "safe"],
    cwd: process.cwd(),
    timeoutMs: 1_000,
    maxOutputBytes: 128,
  });
  assert.equal(result.kind, "completed");
  if (result.kind === "completed") assert.equal(result.stdout.toString(), "safe");
});

test("bounded worker subprocess stops on output limit", async () => {
  const result = await runBoundedMediaProcess({
    command: "/usr/bin/head",
    args: ["-c", "1024", "/dev/zero"],
    cwd: process.cwd(),
    timeoutMs: 1_000,
    maxOutputBytes: 64,
  });
  assert.equal(result.kind, "output_limit_exceeded");
});

test("bounded worker subprocess terminates when the active job is canceled", async () => {
  const result = await runBoundedMediaProcess({
    command: "/bin/sleep",
    args: ["2"],
    cwd: process.cwd(),
    timeoutMs: 5_000,
    maxOutputBytes: 64,
    isCancellationRequested: async () => true,
    cancellationPollMs: 10,
  });
  assert.equal(result.kind, "canceled");
});

test("job temporary workspace is removed exactly once", async () => {
  let createdPath = "";
  await withJobTempWorkspace("job-safe-id", async (workspace) => {
    createdPath = workspace.path;
    await access(workspace.path);
    await workspace.close();
  });
  await assert.rejects(access(createdPath));

  const workspace = await createJobTempWorkspace("job-idempotent-close");
  await Promise.all([workspace.close(), workspace.close()]);
});
