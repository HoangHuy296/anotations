import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test, { after } from "node:test";
import { DatasetMemberRole, Modality, UserRole } from "@internal/db";

import { db } from "@/lib/db";
import { addWorkspaceMember, createWorkspaceDataset, createWorkspaceUser } from "../workspace/helpers.js";

/**
 * T013: the production `PATCH /api/datasets/[datasetId]` handler is invoked directly (no HTTP server).
 *
 * Same established pattern as tests/workspace/workspace-state.test.ts: only `@/lib/auth` is replaced, because
 * `getRequestActor()` calls `cookies()`, which throws outside a request scope. Everything else is the real
 * production code: the exported PATCH, requireDatasetPermission (authorization is NOT stubbed; the actor is a real
 * user row and membership/ownership is resolved from the receipt-owned disposable database), Zod validation and Prisma.
 * The stub is active only while the route module loads; unauthenticated is simulated by returning no actor.
 */
const require = createRequire(import.meta.url);
const Module = require("node:module") as {
  _load: (id: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (id: string, parent: unknown, isMain: boolean) => string;
};
const authPath = require.resolve("@/lib/auth");
type Actor = { id: string; role: UserRole; email: string; name: string } | null;
const state: { actor: Actor } = { actor: null };
const originalLoad = Module._load;
Module._load = function (id, parent, isMain) {
  if (Module._resolveFilename(id, parent, isMain) === authPath) return { getRequestActor: async () => state.actor };
  return originalLoad.call(this, id, parent, isMain);
};
let PATCH: typeof import("@/app/api/datasets/[datasetId]/route")["PATCH"];
try { ({ PATCH } = require("@/app/api/datasets/[datasetId]/route")); }
finally { Module._load = originalLoad; }

const created = { users: [] as string[], datasets: [] as string[] };
const actorOf = (user: { id: string; email: string; name: string; role: UserRole }): Actor => ({ id: user.id, role: user.role, email: user.email, name: user.name });
const patch = async (datasetId: string, body: unknown, raw?: string): Promise<Response> => {
  const response = await PATCH(
    new Request(`http://fixture.invalid/api/datasets/${datasetId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: raw ?? JSON.stringify(body) }),
    { params: Promise.resolve({ datasetId }) },
  );
  assert.ok(response, "the production handler must return a Response");
  return response;
};
const snapshot = async (datasetId: string) => JSON.stringify(await db.dataset.findUniqueOrThrow({ where: { id: datasetId } }), (_key, value) => (typeof value === "bigint" ? value.toString() : value));

async function fixture() {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const outsider = await createWorkspaceUser(UserRole.LABELER);
  const labeler = await createWorkspaceUser(UserRole.LABELER);
  const dataset = await createWorkspaceDataset(owner.id, Modality.IMAGE);
  await addWorkspaceMember(dataset.id, labeler.id, DatasetMemberRole.LABELER);
  created.users.push(owner.id, outsider.id, labeler.id); created.datasets.push(dataset.id);
  return { owner, outsider, labeler, dataset };
}

after(async () => {
  // Best-effort removal of this file's own fixture rows only (the database is disposable and discarded anyway).
  try {
    await db.datasetMember.deleteMany({ where: { datasetId: { in: created.datasets } } });
    await db.dataset.deleteMany({ where: { id: { in: created.datasets } } });
    await db.user.deleteMany({ where: { id: { in: created.users } } });
  } catch { /* leave rows to the disposable teardown */ }
});

test("assertions 1-4: PATCH with modality is 409 DATASET_MODALITY_IMMUTABLE and mutates nothing, including other fields in the same request", async () => {
  const { owner, dataset } = await fixture();
  state.actor = actorOf(owner);
  const before = await snapshot(dataset.id);
  const beforeRow = await db.dataset.findUniqueOrThrow({ where: { id: dataset.id }, select: { name: true, description: true, modality: true } });
  for (const modality of ["VIDEO", "IMAGE", "TEXT", null, "not-a-modality"]) {
    const response = await patch(dataset.id, { modality, name: "must-not-apply", description: "must-not-apply", primaryModality: "AUDIO", metadata: { leaked: true } });
    assert.equal(response.status, 409, `modality=${String(modality)}`);
    assert.equal((await response.json()).error.code, "DATASET_MODALITY_IMMUTABLE");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await snapshot(dataset.id), before, `the whole Dataset row must be byte-identical after a rejected PATCH (modality=${String(modality)})`);
  }
  const after = await db.dataset.findUniqueOrThrow({ where: { id: dataset.id }, select: { name: true, description: true, modality: true } });
  assert.deepEqual(after, beforeRow);
  assert.equal(after.modality, Modality.IMAGE);
  assert.notEqual(after.name, "must-not-apply");
});

test("assertion 5: a normal PATCH without modality still succeeds and persists, leaving modality untouched", async () => {
  const { owner, dataset } = await fixture();
  state.actor = actorOf(owner);
  const response = await patch(dataset.id, { name: "renamed-by-test", description: "persisted description" });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.data.name, "renamed-by-test");
  const row = await db.dataset.findUniqueOrThrow({ where: { id: dataset.id }, select: { name: true, description: true, modality: true, modalityContentRevision: true } });
  assert.equal(row.name, "renamed-by-test");
  assert.equal(row.description, "persisted description");
  assert.equal(row.modality, Modality.IMAGE);
  assert.equal(row.modalityContentRevision, BigInt(0));
});

test("assertion 6: unrelated invalid payloads keep the existing 400 INVALID_REQUEST contract and are not turned into the modality 409", async () => {
  const { owner, dataset } = await fixture();
  state.actor = actorOf(owner);
  const before = await snapshot(dataset.id);
  const cases: Array<[string, unknown, string?]> = [
    ["name too short", { name: "x" }],
    ["unknown key", { unrelated: 1 }],
    ["empty object (refine)", {}],
    ["array containing the word modality", ["modality"]],
    ["JSON null", null],
    ["malformed JSON", undefined, "{not json"],
    ["wrong field type", { name: 42 }],
  ];
  for (const [label, body, raw] of cases) {
    const response = await patch(dataset.id, body, raw);
    assert.equal(response.status, 400, label);
    assert.equal((await response.json()).error.code, "INVALID_REQUEST", label);
  }
  assert.equal(await snapshot(dataset.id), before, "invalid payloads mutate nothing");
});

test("authorization is preserved: unauthenticated, non-member and under-privileged callers never reach (or are told about) the modality rule", async () => {
  const { owner, outsider, labeler, dataset } = await fixture();
  const before = await snapshot(dataset.id);
  const body = { modality: "VIDEO", name: "must-not-apply" };

  state.actor = null;
  const anonymous = await patch(dataset.id, body);
  assert.equal(anonymous.status, 401); assert.equal((await anonymous.json()).error.code, "AUTH_REQUIRED");

  state.actor = actorOf(outsider); // authenticated user who is not a member: existing concealment (404), not 409
  const concealed = await patch(dataset.id, body);
  assert.equal(concealed.status, 404); assert.equal((await concealed.json()).error.code, "GITEA_NOT_FOUND");

  state.actor = actorOf(labeler); // member lacking dataset.update: existing 403, not 409
  const forbidden = await patch(dataset.id, body);
  assert.equal(forbidden.status, 403); assert.equal((await forbidden.json()).error.code, "FORBIDDEN");

  assert.equal(await snapshot(dataset.id), before, "no unauthorized request mutated the Dataset");

  state.actor = actorOf(owner); // control: the same body is only answered with 409 for an authorized caller
  assert.equal((await patch(dataset.id, body)).status, 409);
  assert.equal(await snapshot(dataset.id), before);
});

// ---------------------------------------------------------------------------------------------------------------
// Adjacent defect investigation: omitted `metadata` must mean "leave unchanged".
// Authoritative contract: specs/api/schemas/dataset.yaml UpdateDatasetRequest ("At least one field is required";
// metadata: "When provided, replaces the metadata object"; type: object, so null is invalid) and OpenAPI PATCH 400.
// Dataset.metadata carries workflowStatus (drives the COMPLETED -> visualization destination) and import provenance.
// These assert the INTENDED contract; they are expected to fail against the unfixed schema (create-time default leaking
// into the update schema) and are the proof of that defect.
// ---------------------------------------------------------------------------------------------------------------
const BASELINE_METADATA = { source: "repository", externalId: "abc", workflowStatus: "COMPLETED" };
async function metadataFixture() {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await db.dataset.create({
    data: { ownerId: owner.id, name: `metadata-patch-${Date.now()}`, modality: Modality.IMAGE, modalityResolverSubject: owner.id, metadata: BASELINE_METADATA },
    select: { id: true },
  });
  created.users.push(owner.id); created.datasets.push(dataset.id);
  state.actor = actorOf(owner);
  return dataset.id;
}
const storedMetadata = async (datasetId: string) => (await db.dataset.findUniqueOrThrow({ where: { id: datasetId }, select: { metadata: true } })).metadata;

test("metadata semantics: omitting metadata leaves distinctive stored metadata untouched for every non-metadata PATCH", async () => {
  const datasetId = await metadataFixture();
  for (const body of [{ description: "changed description" }, { name: "renamed with metadata" }, { type: "IMAGE_LABELING" }, { primaryModality: "IMAGE" }, { description: "two", name: "fields" }]) {
    const response = await patch(datasetId, body);
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.deepEqual(await storedMetadata(datasetId), BASELINE_METADATA, `stored metadata must survive ${JSON.stringify(body)}`);
  }
  assert.equal((await db.dataset.findUniqueOrThrow({ where: { id: datasetId }, select: { description: true } })).description, "two");
});

test("metadata semantics: PATCH {} fails the at-least-one-field rule and changes nothing", async () => {
  const datasetId = await metadataFixture();
  const response = await patch(datasetId, {});
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "INVALID_REQUEST");
  assert.deepEqual(await storedMetadata(datasetId), BASELINE_METADATA);
});

test("metadata semantics: explicit metadata replaces the object ({} is a deliberate clear); null and non-objects are invalid", async () => {
  const datasetId = await metadataFixture();
  for (const bad of [null, [], "text", 7]) {
    const response = await patch(datasetId, { metadata: bad });
    assert.equal(response.status, 400, `metadata=${JSON.stringify(bad)}`);
    assert.deepEqual(await storedMetadata(datasetId), BASELINE_METADATA, `invalid metadata ${JSON.stringify(bad)} must not mutate`);
  }
  const replaced = await patch(datasetId, { metadata: { replaced: true } });
  assert.equal(replaced.status, 200);
  assert.deepEqual(await storedMetadata(datasetId), { replaced: true });
  const cleared = await patch(datasetId, { metadata: {} });
  assert.equal(cleared.status, 200);
  assert.deepEqual(await storedMetadata(datasetId), {}, "explicit empty object intentionally clears metadata");
});

test("metadata semantics: workflowStatus-only PATCH merges into existing metadata (existing behavior preserved)", async () => {
  const datasetId = await metadataFixture();
  const response = await patch(datasetId, { workflowStatus: "REVIEWED" });
  assert.equal(response.status, 200);
  assert.deepEqual(await storedMetadata(datasetId), { ...BASELINE_METADATA, workflowStatus: "REVIEWED" });
});

test("metadata semantics: a rejected modality PATCH never touches distinctive metadata", async () => {
  const datasetId = await metadataFixture();
  const response = await patch(datasetId, { modality: "VIDEO", metadata: { overwritten: true } });
  assert.equal(response.status, 409);
  assert.deepEqual(await storedMetadata(datasetId), BASELINE_METADATA);
});
