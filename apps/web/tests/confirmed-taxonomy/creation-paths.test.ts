import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { UserRole } from "@internal/db";

import { assignClassColors, analyzeConfirmedClasses, MAX_CONFIRMED_CLASSES } from "@annotationplatform/domain/confirmed-classes";
import { db } from "@/lib/db";
import { prepareConfirmedClasses } from "@/lib/imports/confirmed-classes-server";
import { prepareDatasetAppendImport, prepareLocalFolderImport } from "@/lib/imports/prepare-local-folder-import";
import { LABEL_COLOR_PRESETS } from "@/lib/labels/label-color-presets";
import { createAndEnqueueNewDatasetSourceImportJob } from "@/lib/queue/enqueue-job";
import { creationRequestHash } from "@/lib/repository-import/types";
import { createDatasetSchema } from "@/lib/validation/dataset";
import { normalizeLabelName } from "@/lib/validation/label-name";
import { appendLocalFolderImportSchema, startLocalFolderImportSchema } from "@/lib/validation/local-folder-import";
import { repositoryImportRequestSchema } from "@/lib/validation/repository-import-request";
import { sourceImportPreflightSchema } from "@/lib/validation/source-connection";
import { createWorkspaceUser } from "../workspace/helpers.js";
import { buildSafeManifest } from "../local-folder-import/helpers.js";

/**
 * T015 confirmed-taxonomy creation paths against the disposable chain (23 historical -> 24 -> 25), REHEARSAL-ONLY: invoked solely by
 * `verify:confirmed-taxonomy-creation`. Every database effect goes through the application client (@/lib/db) and the application's own
 * creation entry points; the only substituted collaborator is the request-actor lookup of the generic Dataset route (the established
 * pattern of tests/dataset-metadata/dataset-patch-route.test.ts), so real authorization and Prisma are exercised.
 */
const require = createRequire(import.meta.url);
const Module = require("node:module") as { _load: (id: string, parent: unknown, isMain: boolean) => unknown; _resolveFilename: (id: string, parent: unknown, isMain: boolean) => string };
const authPath = require.resolve("@/lib/auth");
type Actor = { id: string; role: UserRole; email: string; name: string };
const state: { actor: Actor | null } = { actor: null };
const originalLoad = Module._load;
Module._load = function (id, parent, isMain) {
  if (Module._resolveFilename(id, parent, isMain) === authPath) return { getRequestActor: async () => state.actor };
  return originalLoad.call(this, id, parent, isMain);
};
let POST: (request: Request) => Promise<Response | undefined>;
try { ({ POST } = require("@/app/api/datasets/route")); } finally { Module._load = originalLoad; }

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const EXAMPLE = ["Car", " person ", "Traffic Sign"];
const EXAMPLE_COLORS: Record<string, string> = { car: "#9333EA", person: "#A21CAF", "traffic sign": "#EA580C" };
const EXAMPLE_IMAGE_FOLDER_HASH = "3738861fa6fe048ace7a091d87a423513e799ffa50ce6e42a88cbe81f654f8dd";
const key = (label: string) => `${label}-${"k".repeat(20)}`;
const names = (count: number) => Array.from({ length: count }, (_, index) => `class-${String(index).padStart(3, "0")}`);
const newOwner = async () => { const user = await createWorkspaceUser(UserRole.MANAGER); return { id: user.id, role: user.role, email: user.email, name: user.name } satisfies Actor; };
const counts = async (ownerId: string) => ({
  datasets: await db.dataset.count({ where: { ownerId } }),
  jobs: await db.job.count({ where: { createdById: ownerId } }),
  labels: await db.label.count({ where: { dataset: { ownerId } } }),
  prepared: await db.preparedImport.count({ where: { createdById: ownerId } }),
});
const labelsOf = (datasetId: string) => db.label.findMany({ where: { datasetId }, orderBy: { normalizedName: "asc" }, select: { id: true, name: true, normalizedName: true, color: true, modality: true, scope: true, updatedAt: true, datasetId: true } });
const post = async (actor: Actor, body: unknown) => { state.actor = actor; const response = await POST(new Request("http://fixture.invalid/api/datasets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })); assert.ok(response); return response; };

test("schemas: confirmedClasses is optional, 0..100, name-validated, duplicate-free; preview and append never accept it", () => {
  const dataset = (extra: Record<string, unknown>) => createDatasetSchema.safeParse({ name: "dd", modality: "IMAGE", ...extra }).success;
  const folder = (extra: Record<string, unknown>) => startLocalFolderImportSchema.safeParse({ name: "dd", modality: "IMAGE", idempotencyKey: key("s"), items: buildSafeManifest(), ...extra }).success;
  const repo = (extra: Record<string, unknown>) => repositoryImportRequestSchema.safeParse({ modality: "IMAGE", provider: "GITHUB", repository: { owner: "o", name: "r", repoUrl: "https://github.com/o/r", ref: "main", expectedVisibility: "PUBLIC" }, credentialMode: "PUBLIC", datasetName: "dd", idempotencyKey: key("r"), ...extra }).success;
  for (const accepts of [dataset, folder, repo]) {
    assert.equal(accepts({}), true, "absent"); assert.equal(accepts({ confirmedClasses: [] }), true, "[]");
    for (const count of [1, 24, 25, 100]) assert.equal(accepts({ confirmedClasses: names(count) }), true, String(count));
    assert.equal(accepts({ confirmedClasses: names(101) }), false, "101");
    assert.equal(accepts({ confirmedClasses: ["Car", "car"] }), false, "duplicate"); assert.equal(accepts({ confirmedClasses: ["Car", " CAR "] }), false, "duplicate with padding");
    for (const bad of [["a"], ["x".repeat(51)], [""], [" a "], [7], "Car", null, { 0: "Car" }]) assert.equal(accepts({ confirmedClasses: bad }), false, JSON.stringify(bad));
    assert.equal(accepts({ confirmedClasses: ["Car", "Cars"] }), true);
  }
  assert.equal(appendLocalFolderImportSchema.safeParse({ idempotencyKey: key("a"), items: buildSafeManifest(), confirmedClasses: ["Car"] }).success, false, "append never carries classes");
  assert.equal(sourceImportPreflightSchema.safeParse({ provider: "GITHUB", datasetName: "dd", credentialMode: "PUBLIC", repository: { owner: "o", repo: "r", ref: "main", expectedVisibility: "PUBLIC" }, confirmedClasses: ["Car"] }).success, false, "preview stays read-only and class-free");
  assert.equal(MAX_CONFIRMED_CLASSES, 100);
});

test("normalization used for Labels is exactly normalizeLabelName; colors equal the shared palette assignment", () => {
  const prepared = prepareConfirmedClasses(EXAMPLE, "IMAGE");
  assert.deepEqual(prepared.labels.map((label) => label.normalizedName), EXAMPLE.map(normalizeLabelName));
  assert.deepEqual(prepared.labels.map((label) => label.name), ["Car", "person", "Traffic Sign"]);
  assert.deepEqual(Object.fromEntries(prepared.labels.map((label) => [label.normalizedName, label.color])), EXAMPLE_COLORS);
  assert.deepEqual(prepared.sortedNormalized, ["car", "person", "traffic sign"]);
  for (const sample of ["  ÉCOLE ", "STRASSE", "İx", "A  B"]) assert.equal(prepareConfirmedClasses([sample], "IMAGE").labels[0]!.normalizedName, normalizeLabelName(sample), sample);
  assert.throws(() => prepareConfirmedClasses(["Car", "car"], "IMAGE"), /CONFIRMED_CLASSES_INVALID/);
  assert.throws(() => prepareConfirmedClasses(names(101), "IMAGE"), /CONFIRMED_CLASSES_INVALID/);
});

test("generic Dataset creation: atomic Labels, modality/scope/color rules, 0/1/24/25/100/101 boundaries, validation before side effects, no idempotency", async (t) => {
  const owner = await newOwner();
  await t.test("absent and [] create a Dataset without Labels", async () => {
    for (const body of [{ name: "no-classes", modality: "IMAGE" }, { name: "empty-classes", modality: "IMAGE", confirmedClasses: [] }]) assert.equal((await post(owner, body)).status, 201);
    assert.deepEqual(await counts(owner.id), { datasets: 2, jobs: 0, labels: 0, prepared: 0 });
  });
  await t.test("example classes: trimmed first spelling, OBJECT scope, Dataset modality, derived uppercase colors", async () => {
    const response = await post(owner, { name: "with-classes", modality: "IMAGE", confirmedClasses: EXAMPLE });
    assert.equal(response.status, 201);
    const dataset = (await response.json()).data;
    const labels = await labelsOf(dataset.id);
    assert.deepEqual(labels.map((label) => [label.name, label.normalizedName, label.modality, label.scope, label.color]), [
      ["Car", "car", "IMAGE", "OBJECT", "#9333EA"], ["person", "person", "IMAGE", "OBJECT", "#A21CAF"], ["Traffic Sign", "traffic sign", "IMAGE", "OBJECT", "#EA580C"],
    ]);
  });
  await t.test("every modality: Labels take the Dataset modality with OBJECT scope (no TEXT scope is inferred)", async () => {
    for (const modality of ["VIDEO", "AUDIO", "TEXT"] as const) {
      const response = await post(owner, { name: `m-${modality}`, modality, confirmedClasses: ["Alpha", "Beta"] });
      assert.equal(response.status, 201, modality);
      const labels = await labelsOf((await response.json()).data.id);
      assert.deepEqual(labels.map((label) => [label.modality, label.scope]), [[modality, "OBJECT"], [modality, "OBJECT"]], modality);
    }
  });
  await t.test("boundaries: 1, 24, 25 and 100 classes create; colors are unique for the first 24 and equal the shared assignment", async () => {
    for (const count of [1, 24, 25, 100]) {
      const response = await post(owner, { name: `n-${count}`, modality: "IMAGE", confirmedClasses: names(count) });
      assert.equal(response.status, 201, String(count));
      const labels = await labelsOf((await response.json()).data.id);
      assert.equal(labels.length, count);
      const sorted = [...labels.map((label) => label.normalizedName)].sort();
      const expected = assignClassColors(sorted, LABEL_COLOR_PRESETS);
      for (const label of labels) { assert.equal(label.color, expected.get(label.normalizedName)); assert.match(label.color, /^#[0-9A-F]{6}$/); }
      if (count <= 24) assert.equal(new Set(labels.map((label) => label.color)).size, count, "distinct while the palette has room");
    }
  });
  await t.test("101 classes, duplicates and invalid names are 400 INVALID_REQUEST with no side effect", async () => {
    const before = await counts(owner.id);
    for (const bad of [names(101), ["Car", "car"], ["a"], ["x".repeat(51)], [""], "Car", null, [7]]) {
      const response = await post(owner, { name: "rejected", modality: "IMAGE", confirmedClasses: bad });
      assert.equal(response.status, 400, JSON.stringify(bad).slice(0, 40)); assert.equal((await response.json()).error.code, "INVALID_REQUEST");
    }
    assert.deepEqual(await counts(owner.id), before);
  });
  await t.test("the generic route stays non-idempotent: the same body creates two Datasets with their own Labels", async () => {
    const before = await counts(owner.id);
    for (let i = 0; i < 2; i += 1) assert.equal((await post(owner, { name: "twice", modality: "IMAGE", confirmedClasses: ["Same"] })).status, 201);
    const after = await counts(owner.id);
    assert.equal(after.datasets, before.datasets + 2); assert.equal(after.labels, before.labels + 2);
  });
  await t.test("a database failure while creating a Label rolls the Dataset back (nested create is atomic)", async () => {
    const before = await counts(owner.id);
    state.actor = owner;
    let failed = false;
    try { const response = await POST(new Request("http://fixture.invalid/api/datasets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "rollback", modality: "IMAGE", confirmedClasses: ["ok-name", "bad\u0000name"] }) })); failed = !response || response.status >= 500; } catch { failed = true; }
    assert.equal(failed, true, "the NUL byte cannot be stored, so the creation fails");
    assert.deepEqual(await counts(owner.id), before, "neither the Dataset nor any Label survived");
  });
});

// ---- repository creation (service boundary; the provider preflight is out of scope here) --------------------------------
const repositoryRequest = (idempotencyKey: string, confirmedClasses?: string[]) => repositoryImportRequestSchema.parse({
  modality: "IMAGE", provider: "GITHUB", repository: { owner: "octo", name: "demo", repoUrl: "https://github.com/octo/demo", ref: "main", expectedVisibility: "PUBLIC" },
  credentialMode: "PUBLIC", datasetName: "taxonomy-repo", idempotencyKey, ...(confirmedClasses === undefined ? {} : { confirmedClasses }),
});
const requestHash = (idempotencyKey: string, confirmedClasses?: string[]) => creationRequestHash(repositoryRequest(idempotencyKey, confirmedClasses), null, "https://github.com");
const legacyHash = (idempotencyKey: string) => { const request = repositoryRequest(idempotencyKey); return sha(JSON.stringify({ version: 1, provider: request.provider, owner: "octo", name: "demo", ref: "main", rootPath: null, expectedVisibility: "PUBLIC", credentialMode: "PUBLIC", sourceConnectionId: null, serverUrl: "https://github.com", connectionName: null, datasetName: "taxonomy-repo", modality: "IMAGE" })); };
const repositoryInput = (idempotencyKey: string, confirmedClasses?: readonly string[]) => ({
  datasetName: "taxonomy-repo", modality: "IMAGE" as const,
  creationIdempotency: { key: idempotencyKey, requestHash: requestHash(idempotencyKey, confirmedClasses ? [...confirmedClasses] : undefined) },
  sourceConnection: null, createSourceConnection: null,
  repository: { provider: "GITHUB" as const, baseUrl: "https://github.com", owner: "octo", repo: "demo", ref: "main", normalizedRootPath: "", visibility: "PUBLIC" as const },
  manifest: { itemCount: 2, declaredBytes: 100 }, ...(confirmedClasses === undefined ? {} : { confirmedClasses }),
});

test("repository creation identity: no-class identity is unchanged; taxonomy joins it only when non-empty, by sorted normalized names", () => {
  const k = key("hash");
  assert.equal(requestHash(k), legacyHash(k), "absent classes keep the exact historical identity");
  assert.equal(requestHash(k, []), legacyHash(k), "[] keeps it too");
  assert.notEqual(requestHash(k, ["Car"]), legacyHash(k));
  assert.equal(requestHash(k, EXAMPLE), requestHash(k, ["traffic sign", "CAR", "Person"]), "order and casing are not identity");
  assert.notEqual(requestHash(k, EXAMPLE), requestHash(k, ["Car", "Person"]));
  assert.notEqual(requestHash(k, ["Car"]), requestHash(k, ["Cars"]));
  assert.equal(requestHash(k, ["A1", "b2"]), requestHash(k, [" B2", "a1 "]));
});

test("repository creation: Dataset + Job + Labels in one transaction, equivalent replay reuses without touching Labels, conflicts and rollback leave nothing", async (t) => {
  const owner = await newOwner();
  const k = key("repo-main");
  let datasetId = "";
  let original: Awaited<ReturnType<typeof labelsOf>> = [];
  await t.test("creation with classes", async () => {
    const result = await createAndEnqueueNewDatasetSourceImportJob(owner, repositoryInput(k, EXAMPLE));
    assert.equal(result.ok, true); if (!result.ok) return;
    assert.equal(result.reused, false);
    datasetId = result.datasetId;
    original = await labelsOf(datasetId);
    assert.deepEqual(original.map((label) => [label.name, label.modality, label.scope, label.color]), [["Car", "IMAGE", "OBJECT", "#9333EA"], ["person", "IMAGE", "OBJECT", "#A21CAF"], ["Traffic Sign", "IMAGE", "OBJECT", "#EA580C"]]);
    assert.equal((await db.dataset.findUniqueOrThrow({ where: { id: datasetId }, select: { creationRequestHash: true } })).creationRequestHash, requestHash(k, EXAMPLE));
    assert.deepEqual(await counts(owner.id), { datasets: 1, jobs: 1, labels: 3, prepared: 0 });
  });
  await t.test("equivalent replay (other order and casing) reuses the original result and rewrites nothing", async () => {
    const replay = await createAndEnqueueNewDatasetSourceImportJob(owner, repositoryInput(k, ["traffic sign", "CAR", "Person"]));
    assert.equal(replay.ok, true); if (!replay.ok) return;
    assert.equal(replay.reused, true); assert.equal(replay.datasetId, datasetId);
    assert.deepEqual(await labelsOf(datasetId), original, "ids, display names, colors and updatedAt are untouched");
    assert.deepEqual(await counts(owner.id), { datasets: 1, jobs: 1, labels: 3, prepared: 0 });
  });
  await t.test("a different class list under the same key is IDEMPOTENCY_KEY_CONFLICT with no new rows", async () => {
    for (const changed of [["Car", "Person"], ["Car", "person", "Traffic Sign", "Bus"], ["Car", "person", "Stop Sign"], undefined, []]) {
      const result = await createAndEnqueueNewDatasetSourceImportJob(owner, repositoryInput(k, changed));
      assert.equal(result.ok, false); if (!result.ok) { assert.equal(result.status, 409); assert.equal("reason" in result && result.reason, "IDEMPOTENCY_KEY_CONFLICT"); }
    }
    assert.deepEqual(await labelsOf(datasetId), original);
    assert.deepEqual(await counts(owner.id), { datasets: 1, jobs: 1, labels: 3, prepared: 0 });
  });
  await t.test("no-class creation is unchanged: no Labels, [] replays as absent, adding classes under that key conflicts", async () => {
    const plain = key("repo-plain");
    const first = await createAndEnqueueNewDatasetSourceImportJob(owner, repositoryInput(plain));
    assert.equal(first.ok, true); if (!first.ok) return;
    assert.equal(await db.label.count({ where: { datasetId: first.datasetId } }), 0);
    assert.equal((await db.dataset.findUniqueOrThrow({ where: { id: first.datasetId }, select: { creationRequestHash: true } })).creationRequestHash, legacyHash(plain));
    const again = await createAndEnqueueNewDatasetSourceImportJob(owner, repositoryInput(plain, []));
    assert.equal(again.ok && again.reused, true);
    const conflict = await createAndEnqueueNewDatasetSourceImportJob(owner, repositoryInput(plain, ["Car"]));
    assert.equal(conflict.ok, false); if (!conflict.ok) assert.equal(conflict.status, 409);
  });
  await t.test("101 classes are rejected before any side effect; a failing Label rolls Dataset and Job back", async () => {
    const before = await counts(owner.id);
    // The request schema already rejects these (asserted above); the service is also defensive, so call it directly with a class-free identity.
    await assert.rejects(() => createAndEnqueueNewDatasetSourceImportJob(owner, { ...repositoryInput(key("repo-101")), confirmedClasses: names(101) }), /CONFIRMED_CLASSES_INVALID/);
    await assert.rejects(() => createAndEnqueueNewDatasetSourceImportJob(owner, { ...repositoryInput(key("repo-dup")), confirmedClasses: ["Car", "car"] }), /CONFIRMED_CLASSES_INVALID/);
    assert.deepEqual(await counts(owner.id), before);
    let failed = false;
    try { const result = await createAndEnqueueNewDatasetSourceImportJob(owner, repositoryInput(key("repo-nul"), ["fine-name", "bad\u0000name"])); failed = !result.ok; } catch { failed = true; }
    assert.equal(failed, true);
    assert.deepEqual(await counts(owner.id), before, "no Dataset, Job or Label from the failed creation");
  });
  await t.test("100 classes create within one transaction", async () => {
    const before = await counts(owner.id);
    const result = await createAndEnqueueNewDatasetSourceImportJob(owner, repositoryInput(key("repo-100"), names(100)));
    assert.equal(result.ok, true);
    const after = await counts(owner.id);
    assert.deepEqual(after, { datasets: before.datasets + 1, jobs: before.jobs + 1, labels: before.labels + 100, prepared: 0 });
  });
});

// ---- local-folder creation ---------------------------------------------------------------------------------------------
const startInput = (idempotencyKey: string, options: { classes?: string[]; modality?: "IMAGE" | "VIDEO" | "AUDIO" | "TEXT"; path?: string } = {}) =>
  startLocalFolderImportSchema.parse({ name: "taxonomy-folder", modality: options.modality ?? "IMAGE", idempotencyKey, items: buildSafeManifest([{ logicalPath: options.path ?? "folder/readme.txt", contentType: "text/plain" }]), ...(options.classes === undefined ? {} : { confirmedClasses: options.classes }) });

test("local-folder creation: Dataset + Job + PreparedImport + Labels in one transaction, identity in PreparedImport.creationRequestHash, replay/conflict, rollback, append unchanged", async (t) => {
  const owner = await newOwner();
  const k = key("folder-main");
  let preparation = { id: "", datasetId: "" };
  let original: Awaited<ReturnType<typeof labelsOf>> = [];
  await t.test("creation with classes stores the versioned taxonomy hash and the Labels together", async () => {
    const result = await prepareLocalFolderImport(owner, startInput(k, { classes: EXAMPLE }));
    assert.equal(result.ok, true); if (!result.ok) return;
    preparation = { id: result.preparation.id, datasetId: result.preparation.datasetId };
    original = await labelsOf(preparation.datasetId);
    assert.deepEqual(original.map((label) => [label.name, label.modality, label.scope, label.color]), [["Car", "IMAGE", "OBJECT", "#9333EA"], ["person", "IMAGE", "OBJECT", "#A21CAF"], ["Traffic Sign", "IMAGE", "OBJECT", "#EA580C"]]);
    const row = await db.preparedImport.findUniqueOrThrow({ where: { id: preparation.id }, select: { creationRequestHash: true } });
    assert.equal(row.creationRequestHash, EXAMPLE_IMAGE_FOLDER_HASH);
    assert.deepEqual(await counts(owner.id), { datasets: 1, jobs: 1, labels: 3, prepared: 1 });
  });
  await t.test("equivalent replay returns the same preparation and rewrites no Label", async () => {
    const replay = await prepareLocalFolderImport(owner, startInput(k, { classes: ["traffic sign", "CAR", "Person"] }));
    assert.equal(replay.ok, true); if (!replay.ok) return;
    assert.equal(replay.replayed, true); assert.equal(replay.preparation.id, preparation.id);
    assert.deepEqual(await labelsOf(preparation.datasetId), original, "ids, spelling, colors and updatedAt unchanged");
    assert.deepEqual(await counts(owner.id), { datasets: 1, jobs: 1, labels: 3, prepared: 1 });
  });
  await t.test("changed classes, added/dropped classes, another modality or another manifest are IDEMPOTENCY_KEY_CONFLICT (T014 preserved)", async () => {
    const attempts = [startInput(k, { classes: ["Car", "Person"] }), startInput(k, { classes: [...EXAMPLE, "Bus"] }), startInput(k), startInput(k, { classes: [] }), startInput(k, { classes: EXAMPLE, modality: "VIDEO" }), startInput(k, { classes: EXAMPLE, path: "folder/other.txt" })];
    for (const [index, attempt] of attempts.entries()) {
      const result = await prepareLocalFolderImport(owner, attempt);
      assert.equal(result.ok, false, String(index)); if (!result.ok) { assert.equal(result.status, 409); assert.equal("code" in result && result.code, "IDEMPOTENCY_KEY_CONFLICT"); }
    }
    assert.deepEqual(await labelsOf(preparation.datasetId), original);
    assert.deepEqual(await counts(owner.id), { datasets: 1, jobs: 1, labels: 3, prepared: 1 });
  });
  await t.test("no-class creation: NULL hash, no Labels, T014 replay behavior; [] equals absent; adding classes conflicts", async () => {
    const plain = key("folder-plain");
    const first = await prepareLocalFolderImport(owner, startInput(plain));
    assert.equal(first.ok, true); if (!first.ok) return;
    assert.equal((await db.preparedImport.findUniqueOrThrow({ where: { id: first.preparation.id }, select: { creationRequestHash: true } })).creationRequestHash, null);
    assert.equal(await db.label.count({ where: { datasetId: first.preparation.datasetId } }), 0);
    const replay = await prepareLocalFolderImport(owner, startInput(plain, { classes: [] }));
    assert.equal(replay.ok && replay.replayed, true);
    const conflict = await prepareLocalFolderImport(owner, startInput(plain, { classes: ["Car"] }));
    assert.equal(conflict.ok, false);
  });
  await t.test("append is unchanged: no classes, NULL hash, Labels untouched, replay still works", async () => {
    const append = { idempotencyKey: key("folder-append"), items: buildSafeManifest([{ logicalPath: "more/readme.txt", contentType: "text/plain" }]) };
    const parsed = appendLocalFolderImportSchema.parse(append);
    const first = await prepareDatasetAppendImport(owner, preparation.datasetId, parsed);
    assert.equal(first.ok, true); if (!first.ok || !("preparation" in first)) return;
    assert.equal((await db.preparedImport.findUniqueOrThrow({ where: { id: first.preparation.id }, select: { creationRequestHash: true } })).creationRequestHash, null);
    const replay = await prepareDatasetAppendImport(owner, preparation.datasetId, parsed);
    assert.equal(replay.ok && "replayed" in replay && replay.replayed, true);
    assert.deepEqual(await labelsOf(preparation.datasetId), original);
  });
  await t.test("each modality creates Labels with its own modality and OBJECT scope", async () => {
    for (const modality of ["VIDEO", "AUDIO", "TEXT"] as const) {
      const result = await prepareLocalFolderImport(owner, startInput(key(`folder-${modality}`), { classes: ["Alpha", "Beta"], modality, path: `m/${modality}.txt` }));
      assert.equal(result.ok, true, modality); if (!result.ok) continue;
      assert.deepEqual((await labelsOf(result.preparation.datasetId)).map((label) => [label.modality, label.scope]), [[modality, "OBJECT"], [modality, "OBJECT"]]);
    }
  });
  await t.test("100 classes create; 101 and duplicates are rejected before any side effect; a failing Label rolls back Dataset, Job and PreparedImport", async () => {
    const hundred = await prepareLocalFolderImport(owner, startInput(key("folder-100"), { classes: names(100), path: "h/100.txt" }));
    assert.equal(hundred.ok, true);
    const before = await counts(owner.id);
    await assert.rejects(async () => prepareLocalFolderImport(owner, { ...startInput(key("folder-101")), confirmedClasses: names(101) }), /CONFIRMED_CLASSES_INVALID/);
    await assert.rejects(async () => prepareLocalFolderImport(owner, { ...startInput(key("folder-dup")), confirmedClasses: ["Car", "car"] }), /CONFIRMED_CLASSES_INVALID/);
    assert.deepEqual(await counts(owner.id), before);
    let failed = false;
    try { const result = await prepareLocalFolderImport(owner, { ...startInput(key("folder-nul"), { path: "n/nul.txt" }), confirmedClasses: ["fine-name", "bad\u0000name"] }); failed = !result.ok; } catch { failed = true; }
    assert.equal(failed, true);
    assert.deepEqual(await counts(owner.id), before, "nothing from the failed creation persisted");
  });
  await t.test("class lists are validated independently of existing Labels: equal normalized names in two Datasets are fine", async () => {
    const a = await prepareLocalFolderImport(owner, startInput(key("folder-same-a"), { classes: ["Shared"], path: "s/a.txt" }));
    const b = await prepareLocalFolderImport(owner, startInput(key("folder-same-b"), { classes: ["shared"], path: "s/b.txt" }));
    assert.equal(a.ok && b.ok, true);
    assert.equal(analyzeConfirmedClasses(["Shared"]).ok, true);
  });
});
