import assert from "node:assert/strict";
import test from "node:test";
import { evaluate, normalizeEndpoint, validateCatalog } from "../ai-readiness.mjs";

const CANON = "http://10.0.0.186:7000";
const id = "68d7f474-6982-446c-8c5a-121d56d12dc9";
const entry = { model_id: id, model_name: "YOLO26s_COCO", type: "image", task_name: "detection" };
const ok = { reachable: true, status: 200, body: { success: true, data: [entry] } };
const base = { expect: CANON, web: { url: CANON, aliases: [] }, worker: { url: CANON, aliases: [] }, catalog: ok, workerKeyConfigured: true,
  localRows: [{ key: id, provider: "aioz-company", modality: "IMAGE", taskType: "DETECTION", isActive: true }] };

test("a fully consistent canonical setup is READY", () => assert.equal(evaluate(base).result, "READY"));
test("HTTP 200 alone is not readiness: an empty or unregistered catalog is NOT_READY", () => {
  assert.ok(evaluate({ ...base, localRows: [] }).failing.includes("aidetect-has-at-least-one-usable-model"));
  assert.ok(evaluate({ ...base, catalog: { reachable: true, status: 200, body: { success: true, data: [] } } }).failing.includes("image-detection-models-discovered"));
  assert.ok(evaluate({ ...base, catalog: { reachable: true, status: 200, body: { ok: 1 } } }).failing.includes("model-list-contract-valid"));
});
test("a stale local row for a model the canonical provider does not return is never usable", () => {
  const stale = "11111111-1111-4111-8111-111111111111";
  const r = evaluate({ ...base, localRows: [{ key: stale, provider: "aioz-company", modality: "IMAGE", taskType: "DETECTION", isActive: true }] });
  assert.equal(r.result, "NOT_READY");
  assert.deepEqual(r.checks.find((c) => c.id === "aidetect-has-at-least-one-usable-model").detail.registeredNotInProvider, [stale]);
});
test("inactive, foreign-provider and other-capability rows do not count", () => {
  for (const patch of [{ isActive: false }, { provider: "other" }, { modality: "VIDEO" }, { taskType: "TRACKING" }]) assert.equal(evaluate({ ...base, localRows: [{ ...base.localRows[0], ...patch }] }).result, "NOT_READY");
});
test("web and worker must resolve the identical endpoint and match the frozen canonical one; aliases are flagged", () => {
  assert.ok(evaluate({ ...base, worker: { url: "http://10.0.0.120:8000", aliases: [] } }).failing.includes("web-and-worker-resolve-the-same-endpoint"));
  assert.ok(evaluate({ ...base, web: { url: "http://10.0.0.120:8000", aliases: [] }, worker: { url: "http://10.0.0.120:8000", aliases: [] } }).failing.includes("endpoint-equals-frozen-canonical"));
  assert.ok(evaluate({ ...base, web: { url: undefined, aliases: [] }, worker: { url: undefined, aliases: [] } }).failing.includes("web-endpoint-configured-and-valid"));
  assert.ok(evaluate({ ...base, worker: { url: CANON, aliases: ["AIOZ_COMPANY_API_BASE_URL"] } }).failing.includes("no-endpoint-alias-variables-set"));
});
test("catalog validation rejects entries that ignore the requested filters", () => {
  assert.deepEqual(validateCatalog({ success: true, data: [{ ...entry, type: "video", task_name: "tracking" }] }, { type: "image", taskName: "detection" }), { models: [], violations: ["FILTER_NOT_APPLIED"] });
  assert.equal(normalizeEndpoint("http://u:p@10.0.0.186:7000"), null);
});
