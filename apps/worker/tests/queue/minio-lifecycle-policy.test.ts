import assert from "node:assert/strict";
import test from "node:test";

import { getWorkerConfig } from "../../src/config.js";
import { ensureTempUploadLifecyclePolicy } from "../../src/providers/minio.js";
import { createWorkerMinio } from "../../src/providers/minio.js";

const enabled = process.env.GARBAGE_COLLECTION_RUNTIME_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const skip = enabled ? false : "explicit GARBAGE_COLLECTION_RUNTIME_TESTS=1 + DATABASE_URL required (real MinIO bucket config)";

test("the temp-upload lifecycle policy is applied, prefix-scoped only to direct-uploads/, and is idempotent to re-apply", { skip }, async () => {
  const config = getWorkerConfig();
  const minio = createWorkerMinio(config);

  await ensureTempUploadLifecyclePolicy(minio, config.MINIO_BUCKET, 7);
  const lifecycle = await minio.getBucketLifecycle(config.MINIO_BUCKET);
  assert.ok(lifecycle && "Rule" in lifecycle);
  // The MinIO SDK's XML-derived response collapses `Rule` to a bare object
  // (not a one-element array) when exactly one rule exists -- normalize
  // before treating it as a list.
  type Rule = { ID: string; Status: string; Filter?: { Prefix?: string }; Expiration?: { Days?: number } };
  const rawRule = (lifecycle as { Rule: Rule | Rule[] }).Rule;
  const rules = Array.isArray(rawRule) ? rawRule : [rawRule];

  const directUploadsRule = rules.find((rule) => rule.ID === "annotationplatform-expire-direct-uploads");
  assert.ok(directUploadsRule, "expected a rule scoped to direct-uploads/");
  assert.equal(directUploadsRule!.Filter?.Prefix, "direct-uploads/");
  assert.equal(Number(directUploadsRule!.Expiration?.Days), 7);

  // `prepared-imports/` must NEVER be covered by this database-blind,
  // age-only policy: publishing a local-folder import never renames the
  // object, so a committed Asset's `storageKey` lives under this prefix
  // forever. A rule here previously deleted 490+ live, referenced assets
  // across 37 datasets -- age alone crossed 7 days on objects MinIO had no
  // way to know were still referenced. Only the reference-aware,
  // database-checking sweep (`temp-upload-cleanup.ts`) may ever remove
  // something under this prefix.
  assert.equal(rules.some((rule) => rule.ID === "annotationplatform-expire-prepared-imports"), false, "prepared-imports/ must not have a MinIO-native lifecycle rule -- it is permanent storage for committed assets, not pure staging");
  assert.equal(rules.some((rule) => (rule.Filter?.Prefix ?? "").startsWith("prepared-imports")), false);

  // No rule at all covers a permanent-asset prefix — the policy cannot
  // reach those objects by construction, not merely by a large Days value.
  assert.equal(rules.some((rule) => rule.Filter?.Prefix === "" || rule.Filter?.Prefix === undefined), false, "no rule should apply bucket-wide with no prefix filter");
  assert.equal(rules.some((rule) => (rule.Filter?.Prefix ?? "").startsWith("media-derivatives")), false);
  assert.equal(rules.some((rule) => (rule.Filter?.Prefix ?? "").startsWith("repository-imports")), false);
  assert.equal(rules.some((rule) => (rule.Filter?.Prefix ?? "").startsWith("exports")), false);
  assert.equal(rules.some((rule) => (rule.Filter?.Prefix ?? "").startsWith("audio-waveforms")), false);

  // Re-applying is idempotent — same one rule, not duplicated.
  await ensureTempUploadLifecyclePolicy(minio, config.MINIO_BUCKET, 7);
  const again = await minio.getBucketLifecycle(config.MINIO_BUCKET) as { Rule: Rule | Rule[] };
  const rulesAgain = Array.isArray(again.Rule) ? again.Rule : [again.Rule];
  assert.equal(rulesAgain.length, 1);
});
