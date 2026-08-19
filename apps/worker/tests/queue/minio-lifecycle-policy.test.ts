import assert from "node:assert/strict";
import test from "node:test";

import { getWorkerConfig } from "../../src/config.js";
import { ensureTempUploadLifecyclePolicy } from "../../src/providers/minio.js";
import { createWorkerMinio } from "../../src/providers/minio.js";

const enabled = process.env.GARBAGE_COLLECTION_RUNTIME_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const skip = enabled ? false : "explicit GARBAGE_COLLECTION_RUNTIME_TESTS=1 + DATABASE_URL required (real MinIO bucket config)";

test("the temp-upload lifecycle policy is applied, prefix-scoped only to prepared-imports/ and direct-uploads/, and is idempotent to re-apply", { skip }, async () => {
  const config = getWorkerConfig();
  const minio = createWorkerMinio(config);

  await ensureTempUploadLifecyclePolicy(minio, config.MINIO_BUCKET, 7);
  const lifecycle = await minio.getBucketLifecycle(config.MINIO_BUCKET);
  assert.ok(lifecycle && "Rule" in lifecycle);
  const rules = (lifecycle as { Rule: Array<{ ID: string; Status: string; Filter?: { Prefix?: string }; Expiration?: { Days?: number } }> }).Rule;

  const preparedImportsRule = rules.find((rule) => rule.ID === "fieldframe-expire-prepared-imports");
  const directUploadsRule = rules.find((rule) => rule.ID === "fieldframe-expire-direct-uploads");
  assert.ok(preparedImportsRule, "expected a rule scoped to prepared-imports/");
  assert.ok(directUploadsRule, "expected a rule scoped to direct-uploads/");
  assert.equal(preparedImportsRule!.Filter?.Prefix, "prepared-imports/");
  assert.equal(directUploadsRule!.Filter?.Prefix, "direct-uploads/");
  assert.equal(Number(preparedImportsRule!.Expiration?.Days), 7);
  assert.equal(Number(directUploadsRule!.Expiration?.Days), 7);

  // No rule at all covers a permanent-asset prefix — the policy cannot
  // reach those objects by construction, not merely by a large Days value.
  assert.equal(rules.some((rule) => rule.Filter?.Prefix === "" || rule.Filter?.Prefix === undefined), false, "no rule should apply bucket-wide with no prefix filter");
  assert.equal(rules.some((rule) => (rule.Filter?.Prefix ?? "").startsWith("media-derivatives")), false);
  assert.equal(rules.some((rule) => (rule.Filter?.Prefix ?? "").startsWith("repository-imports")), false);
  assert.equal(rules.some((rule) => (rule.Filter?.Prefix ?? "").startsWith("exports")), false);
  assert.equal(rules.some((rule) => (rule.Filter?.Prefix ?? "").startsWith("audio-waveforms")), false);

  // Re-applying is idempotent — same two rules, not duplicated.
  await ensureTempUploadLifecyclePolicy(minio, config.MINIO_BUCKET, 7);
  const again = await minio.getBucketLifecycle(config.MINIO_BUCKET) as { Rule: unknown[] };
  assert.equal(again.Rule.length, 2);
});
