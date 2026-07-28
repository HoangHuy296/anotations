import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { POST } from "@/app/api/source-import-jobs/route";

test("the retired source-import-jobs route cannot be a second public Dataset/Job creation adapter", async () => {
  const response = await POST();
  assert.equal(response.status, 410);
  const body = await response.json() as { error?: { code?: string; message?: string } };
  assert.deepEqual(body.error?.code, "SOURCE_IMPORT_JOBS_DEPRECATED");
  assert.equal(JSON.stringify(body).includes("token"), false);
  assert.equal(JSON.stringify(body).includes("queue"), false);
});

test("the retained datasets/imports UI uses preflight plus the sole durable acceptance route", async () => {
  const source = await readFile(new URL("../../src/components/imports/import-form.tsx", import.meta.url), "utf8");
  assert.equal(source.includes('"/api/source-import-jobs"'), false);
  assert.equal(source.includes('"/api/datasets/from-repository"'), true);
  assert.equal(source.includes('"/api/source-import-preflight"'), true);
});
