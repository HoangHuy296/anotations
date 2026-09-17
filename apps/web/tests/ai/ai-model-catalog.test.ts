import assert from "node:assert/strict";
import test, { beforeEach, afterEach, type TestContext } from "node:test";
import { db } from "@/lib/db";
import { listActiveAiModels, parseModelCatalog } from "@/lib/ai/ai-model-service";

// Prisma delegates are proxies; replace methods directly and restore per test.
function mockModelMethod(t: TestContext, name: "findMany" | "findUnique" | "create" | "updateMany", implementation: (...args: never[]) => unknown) {
  const original = db.aiModel[name];
  const mock = t.mock.fn(implementation);
  Object.assign(db.aiModel, { [name]: mock });
  t.after(() => { Object.assign(db.aiModel, { [name]: original }); });
  return mock;
}

const imageId = "1516e00c-64f3-442d-93fd-71d224088c28";
const videoId = "72ea46f1-5e67-466e-b17c-fdb13320c0bc";
const image = { model_id: imageId, model_name: "Any detector", type: "image", task_name: "detection" };
const video = { model_id: videoId, model_name: "Any tracker", type: "video", task_name: "tracking" };
const local = { id: "internal-id", key: imageId, provider: "aioz-company", modality: "IMAGE", taskType: "DETECTION", isActive: true };
const videoLocal = { ...local, id: "video-internal-id", key: videoId, modality: "VIDEO", taskType: "TRACKING" };
const catalog = { success: true, data: [image, video] };

test("validates upstream success and preserves task metadata", () => {
  assert.equal(parseModelCatalog(catalog)[0].type, "IMAGE");
  assert.equal(parseModelCatalog(catalog)[0].task_name, "detection");
  assert.throws(() => parseModelCatalog({ ...catalog, success: false }));
  assert.throws(() => parseModelCatalog({ success: true, data: [{ type: "image" }] }));
});

test("task names must be present, non-null and non-empty", () => {
  for (const task_name of [null, undefined, "", "   "]) {
    assert.throws(() => parseModelCatalog({ success: true, data: [{ ...image, task_name }] }));
  }
});

test("passes both filters upstream and coalesces only identical concurrent queries", async (t) => {
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    urls.push(url.search);
    assert.equal(url.pathname, "/api/v1/models/list");
    return Response.json(catalog);
  });
  mockModelMethod(t, "findMany", async () => [local, videoLocal]);
  const [images, duplicate, videos] = await Promise.all([
    listActiveAiModels("IMAGE", "detection"), listActiveAiModels("IMAGE", "detection"), listActiveAiModels("VIDEO", "tracking"),
  ]);
  assert.deepEqual(urls.sort(), ["?type=image&task_name=detection", "?type=video&task_name=tracking"]);
  assert.deepEqual(images, duplicate);
  assert.equal(images.length, 1);
  assert.equal(images[0].id, local.id);
  assert.equal(images[0].availableForTasks, true);
  assert.equal(videos.length, 1);
  assert.equal(videos[0].taskType, "TRACKING");
  assert.equal(videos[0].availableForTasks, true);
  await listActiveAiModels("IMAGE", "detection");
  assert.equal(urls.length, 3);
});

test("unregistered provider models remain visible without catalog writes", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json(catalog));
  mockModelMethod(t, "findMany", async () => []);
  const creates = mockModelMethod(t, "create", async () => { throw new Error("discovery must not write"); });
  const models = await listActiveAiModels("IMAGE", "detection");
  assert.equal(creates.mock.callCount(), 0);
  assert.equal(models[0].id, imageId);
  assert.equal(models[0].displayName, image.model_name);
  assert.equal(models[0].availableForTasks, false);
});

test("inactive, conflicting provider and unsupported local capability never become executable", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json(catalog));
  const creates = mockModelMethod(t, "create", async () => { throw new Error("must not create"); });
  for (const change of [{ isActive: false }, { provider: "other" }, { taskType: "SEGMENTATION" }, { modality: "VIDEO" }]) {
    mockModelMethod(t, "findMany", async () => [{ ...local, ...change }]);
    const models = await listActiveAiModels("IMAGE", "detection");
    assert.ok(models.length === 0 || models.every((model) => model.availableForTasks === false));
  }
  assert.equal(creates.mock.callCount(), 0);
});

test("wrong task metadata cannot match a filtered Toolbox request", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ success: true, data: [
    { ...image, task_name: "classification" }, video,
  ] }));
  mockModelMethod(t, "findMany", async () => []);
  const creates = mockModelMethod(t, "create", async () => { throw new Error("must not create"); });
  assert.deepEqual(await listActiveAiModels("IMAGE", "detection"), []);
  assert.equal(creates.mock.callCount(), 0);
});

test("unsupported tasks are discoverable without database writes", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ success: true, data: [{ ...image, task_name: "segmentation" }] }));
  mockModelMethod(t, "findMany", async () => []);
  const creates = mockModelMethod(t, "create", async () => { throw new Error("must not create"); });
  const models = await listActiveAiModels("IMAGE", "segmentation");
  assert.equal(models[0].taskType, "SEGMENTATION");
  assert.equal(models[0].availableForTasks, false);
  assert.equal(creates.mock.callCount(), 0);
});

test("upstream failures can be retried and unfiltered reads do not register models", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
  await assert.rejects(listActiveAiModels(), /AI_MODEL_CATALOG_UNAVAILABLE/);
  t.mock.method(globalThis, "fetch", async () => Response.json(catalog));
  mockModelMethod(t, "findMany", async () => []);
  const creates = mockModelMethod(t, "create", async () => { throw new Error("must not create"); });
  assert.equal((await listActiveAiModels()).length, 2);
  assert.equal(creates.mock.callCount(), 0);
});


test("legacy image detection registrations remain executable without catalog writes", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json(catalog));
  mockModelMethod(t, "findMany", async () => [{ ...local, taskType: "DETECT_OBJECTS" }]);
  const updates = mockModelMethod(t, "updateMany", async () => { throw new Error("stale Prisma enum"); });
  const models = await listActiveAiModels("IMAGE", "detection");
  assert.equal(updates.mock.callCount(), 0);
  assert.equal(models.length, 1);
  assert.equal(models[0].taskType, "DETECTION");
  assert.equal(models[0].availableForTasks, true);
});

test("legacy video detection registrations remain executable as provider tracking models", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ success: true, data: [video] }));
  mockModelMethod(t, "findMany", async () => [{ ...videoLocal, taskType: "DETECT_OBJECTS" }]);
  const models = await listActiveAiModels("VIDEO", "tracking");
  assert.equal(models.length, 1);
  assert.equal(models[0].taskType, "TRACKING");
  assert.equal(models[0].availableForTasks, true);
});

test("every image tool forwards its task name to provider discovery", async (t) => {
  mockModelMethod(t, "findMany", async () => []);
  for (const taskName of ["detection", "segmentation", "oriented_detection", "classification", "ocr"] as const) {
    t.mock.method(globalThis, "fetch", async (url: URL) => {
      assert.equal(url.searchParams.get("type"), "image");
      assert.equal(url.searchParams.get("task_name"), taskName);
      return Response.json({ success: true, data: [{ ...image, task_name: taskName }] });
    });
    const models = await listActiveAiModels("IMAGE", taskName);
    assert.equal(models.length, 1);
    assert.equal(models[0].taskType, taskName.toUpperCase());
  }
});

const originalProviderUrl = process.env.AIOZ_ANNOTATION_SERVICES_URL;
beforeEach(() => { process.env.AIOZ_ANNOTATION_SERVICES_URL = "https://ai.example.test"; });
afterEach(() => {
  if (originalProviderUrl === undefined) delete process.env.AIOZ_ANNOTATION_SERVICES_URL;
  else process.env.AIOZ_ANNOTATION_SERVICES_URL = originalProviderUrl;
});
