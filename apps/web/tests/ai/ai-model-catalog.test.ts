import assert from "node:assert/strict";
import test from "node:test";
import { db } from "@/lib/db";
import { listActiveAiModels, parseModelCatalog } from "@/lib/ai/ai-model-service";

const imageId = "1516e00c-64f3-442d-93fd-71d224088c28";
const catalog = { success: true, data: [
  { model_id: imageId, model_name: "ResNet50", type: "image" },
  { model_id: "72ea46f1-5e67-466e-b17c-fdb13320c0bc", model_name: "Whisper Base", type: "audio" },
] };

test("validates upstream success and normalizes modality", () => {
  assert.equal(parseModelCatalog(catalog)[0].type, "IMAGE");
  assert.throws(() => parseModelCatalog({ ...catalog, success: false }));
  assert.throws(() => parseModelCatalog({ success: true, data: [{ type: "image" }] }));
});

test("filters modality, preserves task IDs, and shares concurrent fetches", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    calls++;
    assert.equal(url.pathname, "/api/v1/models/list");
    return Response.json(catalog);
  });
  const original = db.aiModel.findMany;
  t.after(() => { db.aiModel.findMany = original; });
  db.aiModel.findMany = (async () => [
    { id: "internal-id", key: imageId, modality: "IMAGE", taskType: "CLASSIFY", isActive: true },
  ]) as unknown as typeof db.aiModel.findMany;
  const [images, audio] = await Promise.all([listActiveAiModels("IMAGE"), listActiveAiModels("AUDIO")]);
  assert.equal(calls, 1);
  assert.deepEqual(images.map((model) => model.displayName), ["ResNet50"]);
  assert.equal(images[0].id, "internal-id");
  assert.equal(images[0].availableForTasks, true);
  assert.equal(audio[0].displayName, "Whisper Base");
  assert.equal(audio[0].availableForTasks, false);
  await listActiveAiModels("IMAGE");
  assert.equal(calls, 2);
});

test("upstream failures can be retried", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
  await assert.rejects(listActiveAiModels(), /AI_MODEL_CATALOG_UNAVAILABLE/);
  t.mock.method(globalThis, "fetch", async () => Response.json(catalog));
  const original = db.aiModel.findMany;
  t.after(() => { db.aiModel.findMany = original; });
  db.aiModel.findMany = (async () => []) as unknown as typeof db.aiModel.findMany;
  assert.equal((await listActiveAiModels()).length, 2);
});
