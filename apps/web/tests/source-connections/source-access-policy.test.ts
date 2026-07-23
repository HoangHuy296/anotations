import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSourceRootPath, readSourceAccessPolicy, validateSourceBaseUrl, validateSourceImportLimits } from "@fieldframe/domain";

test("source URL policy denies numeric hosts unless a server allowlist matches", async () => {
  const denied = await validateSourceBaseUrl("https://203.0.113.8", readSourceAccessPolicy({ NODE_ENV: "test" }));
  assert.deepEqual(denied, { ok: false, code: "SOURCE_DESTINATION_NOT_ALLOWED" });
  const allowed = await validateSourceBaseUrl("https://203.0.113.8", readSourceAccessPolicy({ NODE_ENV: "test", SOURCE_ALLOWED_IP_CIDRS: "203.0.113.0/24" }));
  assert.equal(allowed.ok, true);
});

test("source URL policy rejects credentials, query, fragment, and prohibited DNS results", async () => {
  for (const url of ["https://user:pass@example.test", "https://example.test/?token=x", "https://example.test/#secret"]) {
    const result = await validateSourceBaseUrl(url, readSourceAccessPolicy({ NODE_ENV: "test" }), async () => ["203.0.113.10"]);
    assert.equal(result.ok, false);
  }
  const result = await validateSourceBaseUrl("https://safe.example.test", readSourceAccessPolicy({ NODE_ENV: "test" }), async () => ["127.0.0.1"]);
  assert.deepEqual(result, { ok: false, code: "SOURCE_DESTINATION_NOT_ALLOWED" });
  const mixed = await validateSourceBaseUrl("https://mixed.example.test", readSourceAccessPolicy({ NODE_ENV: "test" }), async () => ["203.0.113.10", "10.0.0.1"]);
  assert.deepEqual(mixed, { ok: false, code: "SOURCE_DESTINATION_NOT_ALLOWED" });
  const failedLookup = await validateSourceBaseUrl("https://lookup.example.test", readSourceAccessPolicy({ NODE_ENV: "test" }), async () => { throw new Error("lookup unavailable"); });
  assert.deepEqual(failedLookup, { ok: false, code: "SOURCE_DESTINATION_NOT_ALLOWED" });
});

test("root paths and deployment limits are canonical and browser input cannot widen them", () => {
  const policy = readSourceAccessPolicy({ NODE_ENV: "test", SOURCE_MAX_ROOT_DEPTH: "2", SOURCE_MAX_IMPORT_ITEMS: "2", SOURCE_MAX_DECLARED_BYTES: "10" });
  assert.deepEqual(normalizeSourceRootPath("images/set", policy), { ok: true, value: "images/set" });
  for (const path of ["/etc", "../secrets", "C:\\temp", "a//b", "a/b/c"]) assert.equal(normalizeSourceRootPath(path, policy).ok, false);
  assert.equal(validateSourceImportLimits({ itemCount: 2, declaredBytes: 10 }, policy).ok, true);
  assert.equal(validateSourceImportLimits({ itemCount: 3, declaredBytes: 10 }, policy).ok, false);
  assert.equal(validateSourceImportLimits({ itemCount: 2, declaredBytes: 11 }, policy).ok, false);
});
