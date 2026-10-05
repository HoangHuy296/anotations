import "../../../../scripts/db-safety/test-entry.cjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import type { WorkspaceDataset } from "@/types/workspace";

const require = createRequire(import.meta.url);
const Module = require("node:module") as {
  _load: (id: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (id: string, parent: unknown, isMain: boolean) => string;
};
const authPath = require.resolve("@/lib/auth");
const modalityPath = require.resolve("@/lib/datasets/modality");
const actor = { id: "g5-api-owner", role: "MANAGER", email: "owner@fixture.test", name: "Owner" };
const state: { actor: typeof actor | null; dataset: WorkspaceDataset | null; error: Error | null; calls: unknown[][] } = { actor, dataset: null, error: null, calls: [] };
const originalLoad = Module._load;
// Test-only injection of two exact service modules; all other loads chain the
// existing G1 preload. No Prisma client or persistence fixture is initialized.
Module._load = function (id, parent, isMain) {
  const resolved = Module._resolveFilename(id, parent, isMain);
  if (resolved === authPath) return { getRequestActor: async () => state.actor };
  if (resolved === modalityPath) return { readDatasetModality: async (...args: unknown[]) => {
    state.calls.push(args);
    if (state.error) throw state.error;
    return state.dataset;
  } };
  return originalLoad.call(this, id, parent, isMain);
};
let GET: typeof import("@/app/api/datasets/[datasetId]/workspace-state/route")["GET"];
try { ({ GET } = require("@/app/api/datasets/[datasetId]/workspace-state/route")); }
finally { Module._load = originalLoad; }

const id = "02950000-0000-4000-8000-000000000010";
const context = (datasetId = id) => ({ params: Promise.resolve({ datasetId }) });
const request = () => new Request(`http://fixture.invalid/api/datasets/${id}/workspace-state?engine=VIDEO&assetId=untrusted`);
const publicKeys = ["id", "name", "modality", "modalityResolution", "canResolve"].sort();
const reset = () => { state.actor = actor; state.dataset = null; state.error = null; state.calls = []; };

test("workspace-state HTTP contract delegates only to authorized canonical Dataset state", async t => {
  for (const modality of ["IMAGE", "VIDEO", "AUDIO", "TEXT"] as const) {
    await t.test(`resolved ${modality} has a JSON-safe public routing DTO`, async () => {
      reset();
      const dataset: WorkspaceDataset = { id, name: "Empty resolved", modality, modalityResolution: "RESOLVED", canResolve: false };
      state.dataset = dataset;
      const response = await GET(request(), context());
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const payload = await response.json();
      assert.deepEqual(payload, { data: dataset });
      assert.deepEqual(Object.keys(payload.data).sort(), publicKeys);
      assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload);
      assert.deepEqual(state.calls, [[actor, id]]);
    });
  }
  for (const resolution of ["EMPTY_UNRESOLVED", "MIXED_UNRESOLVED", "SINGLE_UNRESOLVED"] as const) {
    await t.test(`${resolution} has safe 409 state and no private receipt or engine`, async () => {
      reset();
      const dataset: WorkspaceDataset = { id, name: "Historical", modality: null, modalityResolution: resolution, canResolve: resolution === "EMPTY_UNRESOLVED" };
      state.dataset = dataset;
      const response = await GET(request(), context());
      assert.equal(response.status, 409);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const payload = await response.json();
      assert.equal(payload.error.code, "DATASET_MODALITY_UNRESOLVED");
      assert.deepEqual(payload.error.details, { dataset });
      assert.deepEqual(Object.keys(payload.error.details.dataset).sort(), publicKeys);
      assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload);
      for (const key of ["engine", "ownerId", "modalityContentRevision", "modalityResolverSubject", "modalityResolvedAt", "assets"]) assert.ok(!(key in payload.error.details.dataset));
      assert.deepEqual(state.calls, [[actor, id]]);
    });
  }
  await t.test("malformed identifier is rejected before state lookup", async () => {
    reset();
    const response = await GET(request(), context("not-a-dataset-id"));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "INVALID_REQUEST");
    assert.deepEqual(state.calls, []);
  });
  await t.test("unauthenticated state is rejected before lookup", async () => {
    reset(); state.actor = null;
    const response = await GET(request(), context());
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "AUTH_REQUIRED");
    assert.deepEqual(state.calls, []);
  });
  await t.test("missing or unauthorized state is concealed with no Dataset projection", async () => {
    reset();
    const response = await GET(request(), context());
    assert.equal(response.status, 404);
    const payload = await response.json();
    assert.ok(!("data" in payload));
    assert.ok(!("details" in payload.error));
  });
  await t.test("unexpected reader faults never expose private diagnostic text", async () => {
    reset();
    const privateDiagnostic = "private-instance secret-credential";
    state.error = new Error(privateDiagnostic);
    const response = await GET(request(), context());
    assert.equal(response.status, 500);
    const payload = await response.json();
    assert.equal(payload.error.code, "INTERNAL_ERROR");
    assert.ok(!JSON.stringify(payload).includes(privateDiagnostic));
    assert.ok(!("data" in payload));
    assert.ok(!("details" in payload.error));
  });
});
