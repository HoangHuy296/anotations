import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Prisma } from "@internal/db";

import { db } from "@/lib/db";
import { datasetLibraryHref, datasetLibraryQuerySchema, readDatasetWorkflowStatus } from "@/lib/datasets/dataset-library-query";
import { getDatasetLibrary } from "@/lib/datasets/dataset-library-service";
import { getGiteaConnectionCount } from "@/lib/source-provider-summary";

const query = (input = {}) => datasetLibraryQuerySchema.parse(input);

test("filters validate URL input and pagination links preserve both filters", () => {
  assert.deepEqual(query({ status: "unknown", method: "repository", after: "invalid" }), { status: "ALL", method: "ALL", after: undefined });
  const filters = query({ status: "COMPLETED", method: "IMPORT" });
  const id = randomUUID();
  assert.equal(datasetLibraryHref(filters, { after: id }), `/datasets?status=COMPLETED&method=IMPORT&after=${id}`);
  assert.equal(datasetLibraryHref(filters, { before: id }), `/datasets?status=COMPLETED&method=IMPORT&before=${id}`);
  const pagedQuery = { ...filters, after: id };
  assert.equal(datasetLibraryHref(pagedQuery), "/datasets?status=COMPLETED&method=IMPORT");
  assert.equal(datasetLibraryHref(query()), "/datasets");
  for (const metadata of [{}, null, [], { workflowStatus: null }, { workflowStatus: "legacy" }]) assert.equal(readDatasetWorkflowStatus(metadata), "IN_PROGRESS");
});

test("database filters include legacy statuses, compose with ownership, and paginate the entire matching set", { skip: process.env.DATASET_LIBRARY_INTEGRATION_TESTS !== "1" }, async () => {
  const marker = randomUUID();
  const owner = await db.user.create({ data: { email: `library-${marker}@test.invalid`, name: "Library test", role: "MANAGER" } });
  const outsider = await db.user.create({ data: { email: `outside-${marker}@test.invalid`, role: "MANAGER" } });
  const actor = { id: owner.id, email: owner.email, name: owner.name!, role: owner.role };
  const ids: string[] = [];
  try {
    for (let index = 0; index < 10; index++) {
      const metadata = index === 0 ? {} : index === 1 ? { workflowStatus: null } : index === 2 ? { workflowStatus: "legacy" } : index === 3 ? Prisma.JsonNull : { workflowStatus: "IN_PROGRESS" };
      const row = await db.dataset.create({ data: { name: `Upload ${index}`, ownerId: owner.id, sourceMode: "UPLOAD", metadata } });
      ids.push(row.id);
    }
    const completed = await db.dataset.create({ data: { name: "Completed import", ownerId: owner.id, sourceMode: "MIRROR_TO_MINIO", metadata: { workflowStatus: "COMPLETED" } } });
    ids.push(completed.id);
    const reviewed = await db.dataset.create({ data: { name: "Reviewed import", ownerId: owner.id, sourceMode: "HYBRID_CACHE", metadata: { workflowStatus: "REVIEWED" } } });
    ids.push(reviewed.id);
    for (const hidden of [
      { ownerId: outsider.id },
      { ownerId: owner.id, archivedAt: new Date() },
      { ownerId: owner.id, deletedAt: new Date() },
    ]) {
      const row = await db.dataset.create({ data: { name: "Hidden import", sourceMode: "EXTERNAL_REF", metadata: { workflowStatus: "COMPLETED" }, ...hidden } });
      ids.push(row.id);
    }
    const filters = query({ status: "IN_PROGRESS", method: "UPLOAD" });
    const first = await getDatasetLibrary(actor, filters);
    assert.equal(first.total, 10);
    assert.equal(first.datasets.length, 7);
    assert.equal(first.hasNext, true);
    assert.equal(first.hasPrevious, false);
    const second = await getDatasetLibrary(actor, { ...filters, after: first.datasets.at(-1)!.id });
    assert.equal(second.datasets.length, 3);
    assert.equal(second.hasNext, false);
    assert.equal(new Set([...first.datasets, ...second.datasets].map(({ id }) => id)).size, 10);
    const previous = await getDatasetLibrary(actor, { ...filters, before: second.datasets[0].id });
    assert.deepEqual(previous.datasets.map(({ id }) => id), first.datasets.map(({ id }) => id));
    assert.equal((await getDatasetLibrary(actor, query())).total, 12);
    const imports = await getDatasetLibrary(actor, query({ method: "IMPORT" }));
    assert.equal(imports.total, 2);
    assert.deepEqual((await getDatasetLibrary(actor, query({ status: "COMPLETED", method: "IMPORT" }))).datasets.map(({ id }) => id), [completed.id]);
    assert.deepEqual((await getDatasetLibrary(actor, query({ status: "REVIEWED" }))).datasets.map(({ id }) => id), [reviewed.id]);
    assert.equal((await getDatasetLibrary(actor, query({ status: "COMPLETED", method: "UPLOAD" }))).total, 0);

    assert.equal(await getGiteaConnectionCount(owner.id), 0);
    await db.sourceConnection.createMany({ data: [
      { userId: owner.id, provider: "GITEA", tokenEncrypted: "test-only-not-a-real-token" },
      { userId: owner.id, provider: "GITEA", tokenEncrypted: "test-only-not-a-real-token", tokenExpiresAt: new Date(0) },
      { userId: owner.id, provider: "GITEA", status: "ERROR", tokenEncrypted: "test-only-not-a-real-token" },
      { userId: owner.id, provider: "GITEA", revokedAt: new Date(), tokenEncrypted: "test-only-not-a-real-token" },
      { userId: owner.id, provider: "GITEA" },
      { userId: outsider.id, provider: "GITEA", tokenEncrypted: "test-only-not-a-real-token" },
    ] });
    assert.equal(await getGiteaConnectionCount(owner.id), 1, "only own active, unexpired saved connections count");
  } finally {
    await db.dataset.deleteMany({ where: { id: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, outsider.id] } } });
  }
});
