import "../../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";
import { AiozAnnotationServicesProvider, AiozProviderError, digestAiozImageUrl, type AiozTaskResources } from "../../../src/providers/ai/aioz-annotation-services-provider.js";
import { resolveAiProviderForTask } from "../../../src/providers/ai/ai-provider-registry.js";
import { getAiozAnnotationServicesConfig } from "../../../src/config.js";
import type { PrismaClient } from "../../../../../lib/generated/prisma/client.js";

const taskId = "0d850d22-c6d0-4a9e-ac96-25c6f977164a";
const modelId = "0307ee22-5bfa-4f68-bcb5-42fef7d26de3";
const bus = "https://ultralytics.com/images/bus.jpg";
const video = "https://i.ytimg.com/vi/5ku7npMrW40/maxresdefault.jpg";
const images = [{ assetId: "bus", imageUrl: bus }, { assetId: "video", imageUrl: video }];
const config = { baseUrl: "http://aioz.test", apiKey: "test-only-key", timeoutMs: 1_000 };
const input = { aiTaskId: "local-task", modelKey: modelId, assetIds: ["bus", "video"] };
const output = [
  { width: 810, height: 1080, image_path: bus, class_names: ["person", "bicycle", "car"], outputs: [{ box: [668.0579109191895, 392.17174530029297, 809, 880.3952407836914], score: 0.9430617690086365, class_id: 0, class_name: "person" }] },
  { width: 1280, height: 720, image_path: video, class_names: ["person", "bicycle", "car"], outputs: [{ box: [637.1444702148438, 52.26556396484375, 1274.0462646484375, 715.6981201171875], score: 0.9733365774154663, class_id: 0, class_name: "person" }] },
];
const envelope = (status = "success", changes = {}) => ({ success: true, data: { task_id: taskId, status, output, error: null, ...changes } });
function resources(): AiozTaskResources {
  return {
    prepare: async () => ({ modelId, mediaType: "image", taskName: "detection", images, options: { classes: ["person", "bicycle", "car"], confidence_threshold: 0.5, iou_threshold: 0.5 } }),
    recordSubmission: async () => {},
    loadImages: async () => images.map(({ assetId, imageUrl }) => ({ assetId, urlDigest: digestAiozImageUrl(imageUrl) })),
  };
}
function adapter(body: unknown) { return new AiozAnnotationServicesProvider(config, resources(), async () => Response.json(body)); }

test("submit uses confirmed request, API-Key, data.task_id and durable submission callback", async () => {
  const store = resources();
  let saved = false;
  store.recordSubmission = async (localId, remoteId) => { assert.equal(localId, input.aiTaskId); assert.equal(remoteId, taskId); saved = true; };
  const provider = new AiozAnnotationServicesProvider(config, store, async (url, init) => {
    assert.equal(String(url), "http://aioz.test/api/v1/tasks/create");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("API-Key"), config.apiKey);
    assert.deepEqual(JSON.parse(String(init?.body)), { type: "image", task_name: "detection", files: [bus, video], model_id: modelId, classes: ["person", "bicycle", "car"], confidence_threshold: 0.5, iou_threshold: 0.5 });
    return Response.json({ success: true, data: { task_id: taskId, status: "create", created_at: "2026-09-09T07:12:29.789273Z" } }, { status: 202 });
  });
  assert.deepEqual(await provider.submitTask(input), { externalTaskId: taskId });
  assert.equal(saved, true);
});

test("persisted external ID is reused without another HTTP submit", async () => {
  const store = resources();
  store.prepare = async () => ({ externalTaskId: taskId });
  const provider = new AiozAnnotationServicesProvider(config, store, async () => { throw new Error("must not call"); });
  assert.deepEqual(await provider.submitTask(input), { externalTaskId: taskId });
});

test("poll endpoint normalizes reordered real output using durable URL digests after restart", async () => {
  const provider = new AiozAnnotationServicesProvider(config, resources(), async (url, init) => {
    assert.equal(String(url), `http://aioz.test/api/v1/tasks/result/${taskId}`);
    assert.equal(init?.method, "GET");
    return Response.json(envelope("success", { output: [...output].reverse() }));
  });
  const result = await provider.getTaskStatus(taskId);
  assert.equal(result.status, "COMPLETED");
  if (result.status !== "COMPLETED") return;
  const normalized = provider.normalizePredictions(result.rawPredictions);
  assert.deepEqual(normalized.map((item) => item.assetId), ["video", "bus"]);
  assert.equal(normalized[1].labelKey, "person");
  assert.equal(normalized[1].confidence, 0.9430617690086365);
  assert.deepEqual(normalized[1].boundingBoxes, { x: 668.0579109191895 / 810, y: 392.17174530029297 / 1080, width: (809 - 668.0579109191895) / 810, height: (880.3952407836914 - 392.17174530029297) / 1080 });
  assert.equal(JSON.stringify(normalized).includes("image_path"), false);
});

for (const [external, internal] of [["create", "PENDING"], ["pending", "PENDING"], ["inprocess", "IN_PROGRESS"]]) {
  test(`${external} maps to ${internal} without requiring output yet`, async () => {
    assert.deepEqual(await adapter(envelope(external, { output: null })).getTaskStatus(taskId), { status: internal });
  });
}

test("failed status, non-null error and success=false never become empty predictions", async () => {
  for (const body of [envelope("failed"), envelope("success", { error: "private service details" }), { ...envelope(), success: false }]) {
    const result = await adapter(body).getTaskStatus(taskId);
    assert.equal(result.status, "FAILED");
    assert.equal(JSON.stringify(result).includes("private service details"), false);
  }
});

test("unknown status, missing output, invalid box, unknown image and malformed envelope fail closed", async () => {
  for (const body of [{}, envelope("unknown"), envelope("success", { output: null }), envelope("success", { output: [] }), envelope("success", { task_id: modelId }), envelope("success", { output: [{ ...output[0], outputs: [{ ...output[0].outputs[0], box: [0, 0, 900, 20] }] }, output[1]] }), envelope("success", { output: [output[0], { ...output[1], image_path: "https://example.test/other" }] })]) {
    assert.equal((await adapter(body).getTaskStatus(taskId)).status, "FAILED");
  }
});

test("missing task_id and malformed create response reject safely", async () => {
  for (const body of [{}, { success: true, data: { status: "create" } }, { success: false }]) await assert.rejects(adapter(body).submitTask(input), AiozProviderError);
});

for (const code of [400, 401, 403, 404, 429, 500, 503]) {
  test(`HTTP ${code} has safe failure category`, async () => {
    const provider = new AiozAnnotationServicesProvider(config, resources(), async () => new Response("private upstream data", { status: code }));
    const result = await provider.getTaskStatus(taskId);
    assert.equal(result.status, "FAILED");
    if (result.status === "FAILED") assert.equal(result.error.code, code >= 500 ? "AIOZ_HTTP_5XX" : "AIOZ_HTTP_4XX");
    await assert.rejects(provider.submitTask(input), AiozProviderError);
    assert.equal(JSON.stringify(result).includes("private upstream"), false);
  });
}

test("network, timeout, malformed JSON and oversized body failures are bounded and sanitized", async () => {
  const requests: Array<[typeof fetch, string]> = [
    [async () => { throw new Error("private URL and credential"); }, "AIOZ_NETWORK_ERROR"],
    [async (_url, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))), "AIOZ_TIMEOUT"],
    [async () => new Response("not-json"), "AIOZ_INVALID_RESPONSE"],
    [async () => new Response("x".repeat(8 * 1024 * 1024 + 1)), "AIOZ_RESPONSE_TOO_LARGE"],
  ];
  for (const [http, code] of requests) {
    const provider = new AiozAnnotationServicesProvider({ ...config, timeoutMs: 20 }, resources(), http);
    const result = await provider.getTaskStatus(taskId);
    assert.equal(result.status, "FAILED");
    if (result.status === "FAILED") assert.equal(result.error.code, code);
    assert.equal(JSON.stringify(result).includes("credential"), false);
  }
});

test("registry selects real provider lazily, mock remains available, custom registry remains authoritative", async () => {
  const oldKey = process.env.AIOZ_COMPANY_API_KEY;
  const oldUrl = process.env.AIOZ_ANNOTATION_SERVICES_URL;
  try {
    process.env.AIOZ_COMPANY_API_KEY = config.apiKey;
    process.env.AIOZ_ANNOTATION_SERVICES_URL = config.baseUrl;
    const db = { aiModel: { findUnique: async () => ({ provider: "aioz-company", isActive: true }) } } as unknown as PrismaClient;
    assert.ok(await resolveAiProviderForTask(db, { modelId }) instanceof AiozAnnotationServicesProvider);
    const injected = adapter(envelope());
    assert.equal(await resolveAiProviderForTask(db, { modelId }, { "aioz-company": injected }), injected);
    await assert.rejects(resolveAiProviderForTask(db, { modelId }, {}), /AI_PROVIDER_NOT_REGISTERED/);
    const mockDb = { aiModel: { findUnique: async () => ({ provider: "aioz-test-result", isActive: true }) } } as unknown as PrismaClient;
    if (process.env.NODE_ENV !== "production") assert.ok(await resolveAiProviderForTask(mockDb, { modelId }));
  } finally {
    if (oldUrl === undefined) delete process.env.AIOZ_ANNOTATION_SERVICES_URL; else process.env.AIOZ_ANNOTATION_SERVICES_URL = oldUrl;
    if (oldKey === undefined) delete process.env.AIOZ_COMPANY_API_KEY; else process.env.AIOZ_COMPANY_API_KEY = oldKey; }
});

test("config reuses server key and accepts only credential-free HTTP origins", () => {
  assert.throws(() => getAiozAnnotationServicesConfig({ AIOZ_COMPANY_API_KEY: config.apiKey }), /AIOZ_CONFIG_INVALID/);
  assert.equal(getAiozAnnotationServicesConfig({ AIOZ_ANNOTATION_SERVICES_URL: config.baseUrl, AIOZ_COMPANY_API_KEY: config.apiKey }).baseUrl, config.baseUrl);
  for (const baseUrl of ["file:///tmp/api", "http://user:password@example.test", "http://example.test?key=private"]) assert.throws(() => getAiozAnnotationServicesConfig({ AIOZ_ANNOTATION_SERVICES_URL: baseUrl, AIOZ_COMPANY_API_KEY: config.apiKey }), /AIOZ_CONFIG_INVALID/);
});
