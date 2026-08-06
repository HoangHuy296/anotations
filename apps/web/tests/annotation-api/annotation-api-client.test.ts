import assert from "node:assert/strict";
import test from "node:test";

import { putAssetAnnotations } from "@/lib/annotations/annotation-api-client";

test("revision conflict is surfaced once and never retried by the browser API adapter", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { code: "ANNOTATION_REVISION_CONFLICT" } }), { status: 409, headers: { "Content-Type": "application/json" } });
  };
  try {
    const result = await putAssetAnnotations("asset-id", { updates: [{ id: "annotation-id", revision: 1, geometry: { px: 0.1, py: 0.1 } }] });
    assert.deepEqual(result, { ok: false, code: "ANNOTATION_REVISION_CONFLICT", conflict: true });
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
