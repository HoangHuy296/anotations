import assert from "node:assert/strict";
import test from "node:test";

import { logAiEvent, logJobEvent, logRedisEvent, logStorageEvent } from "./log.js";

function captureConsole<T>(run: () => T): { result: T; lines: string[] } {
  const lines: string[] = [];
  const originalInfo = console.info;
  const originalError = console.error;
  console.info = (line: string) => { lines.push(line); };
  console.error = (line: string) => { lines.push(line); };
  try {
    const result = run();
    return { result, lines };
  } finally {
    console.info = originalInfo;
    console.error = originalError;
  }
}

test("logJobEvent emits a single-line JSON entry with the allowlisted job fields", () => {
  const { lines } = captureConsole(() => {
    logJobEvent("JOB_RECOVERED", { jobId: "job_1", attempts: 2, reason: "LEASE_EXPIRED", durationMs: 42 });
  });
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]!);
  assert.equal(parsed.category, "job");
  assert.equal(parsed.event, "JOB_RECOVERED");
  assert.equal(parsed.jobId, "job_1");
  assert.equal(parsed.attempts, 2);
  assert.equal(parsed.reason, "LEASE_EXPIRED");
  assert.equal(parsed.durationMs, 42);
  assert.equal(parsed.level, "info");
  assert.ok(typeof parsed.ts === "string");
});

test("logRedisEvent and logStorageEvent tag their own category", () => {
  const { lines: redisLines } = captureConsole(() => {
    logRedisEvent("RECONNECTED", { detail: "attempt 3" });
  });
  assert.equal(JSON.parse(redisLines[0]!).category, "redis");

  const { lines: storageLines } = captureConsole(() => {
    logStorageEvent("MINIO_ORPHAN_DELETED", { bucket: "annotation-assets", key: "assets/a1" }, "error");
  });
  const storageEntry = JSON.parse(storageLines[0]!);
  assert.equal(storageEntry.category, "storage");
  assert.equal(storageEntry.level, "error");
});

test("logAiEvent never needs a raw provider payload field to satisfy its type", () => {
  const { lines } = captureConsole(() => {
    logAiEvent("AI_TASK_FAILED", { aiTaskId: "task_1", jobId: "job_1", modelId: "model_1", provider: "aioz-company", reason: "TIMEOUT" });
  });
  const parsed = JSON.parse(lines[0]!);
  assert.equal(parsed.category, "ai");
  assert.equal(parsed.aiTaskId, "task_1");
  assert.equal(parsed.provider, "aioz-company");
});

test("a disallowed key anywhere in the payload throws outside production", () => {
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  try {
    assert.throws(() => {
      // @ts-expect-error -- intentionally passing a disallowed key to prove the runtime guard, not just the type system.
      logJobEvent("JOB_FAILED", { jobId: "job_1", accessToken: "should-never-be-logged" });
    }, /disallowed key/);
  } finally {
    process.env.NODE_ENV = originalEnv;
  }
});

test("a disallowed key is redacted (not thrown, not passed through) in production", () => {
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const { lines } = captureConsole(() => {
      // @ts-expect-error -- intentionally passing a disallowed key to prove the runtime guard, not just the type system.
      logJobEvent("JOB_FAILED", { jobId: "job_1", signedUrl: "https://minio.internal/should-never-appear" });
    });
    const parsed = JSON.parse(lines[0]!);
    assert.equal(parsed.signedUrl, "[REDACTED]");
    assert.doesNotMatch(lines[0]!, /minio\.internal/);
  } finally {
    process.env.NODE_ENV = originalEnv;
  }
});
