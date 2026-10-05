import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";
import { DatasetSourceMode, JobStatus, JobType, Modality, Prisma, PreparedImportStatus, UserRole } from "@internal/db";

import { Prisma as BrowserPrisma } from "../../../../lib/generated/prisma/browser";
import { db } from "@/lib/db";

/**
 * Prisma client compatibility for PreparedImport.creationRequestHash (REHEARSAL-ONLY: invoked solely by
 * `compat:prepared-import-creation-request-hash` against a disposable PostgreSQL at 23 historical + migration 24 + migration 25).
 * It uses ONLY normal operations of the application client (`@/lib/db`, backed by the tracked generated Prisma Client) with opaque
 * strings; it does not test T015 hashing, idempotency or taxonomy semantics. No raw SQL and no other database access.
 *
 * Final fixture state (one user, five PreparedImport rows, each with its own Dataset and Job):
 *
 *   key           creationRequestHash   how it gets there
 *   k-lifecycle   null                  created VA -> read -> updated VB -> read -> updated null -> read
 *   k-omitted     null                  created with the field omitted
 *   k-dup1        VB                    created with VB
 *   k-dup2        VB                    created with VB (duplicate non-null value accepted: no uniqueness)
 *   k-extra       VC                    created with VC, with two nested PreparedImportItem rows (a third is added later)
 *
 * Expected counts: all 5 | = VA 0 | = VB 2 (k-dup1, k-dup2) | = VC 1 | IS NULL 2 | NOT NULL 3 | aggregate _count(field) 3.
 */
const VA = "compat-A-prepared-import-hash";
const VB = "compat-B-prepared-import-hash";
const VC = "compat-C-prepared-import-hash";
const DEADLINE = new Date("2030-01-01T00:00:00.000Z");
const FIELDS = ["id", "datasetId", "jobId", "createdById", "status", "expectedItemCount", "deadlineAt", "committedAt", "idempotencyKey", "creationRequestHash", "createdAt", "updatedAt"];

test("PreparedImport.creationRequestHash works through the regenerated application Prisma Client", async (t) => {
  const owner = await db.user.create({ data: { email: "client-compat@test.invalid", name: "client-compat", role: UserRole.MANAGER }, select: { id: true } });
  const ids: Record<string, { id: string; datasetId: string; jobId: string }> = {};

  async function makeRow(key: string, options: { hash?: string | null; items?: number } = {}) {
    const items = options.items ?? 0;
    const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `compat-${key}`, modality: Modality.IMAGE, primaryModality: Modality.IMAGE, modalityResolverSubject: owner.id, sourceMode: DatasetSourceMode.UPLOAD }, select: { id: true } });
    const job = await db.job.create({ data: { datasetId: dataset.id, createdById: owner.id, type: JobType.IMPORT_DATASET, status: JobStatus.RUNNING, totalItems: items, input: {} }, select: { id: true } });
    const created = await db.preparedImport.create({
      data: {
        datasetId: dataset.id, jobId: job.id, createdById: owner.id, expectedItemCount: items, deadlineAt: DEADLINE, idempotencyKey: key,
        ...(options.hash === undefined ? {} : { creationRequestHash: options.hash }),
        ...(items > 0 ? { items: { create: Array.from({ length: items }, (_, position) => ({ position, logicalPath: `compat/${key}/${position}.bin`, normalizedPath: `compat/${key}/${position}.bin`, filename: `${position}.bin`, mimeType: "application/octet-stream", sizeBytes: BigInt(position + 1), modality: Modality.IMAGE, fingerprint: `fp-${key}-${position}`, storageKey: `compat/${key}/${position}` })) } } : {}),
      },
      select: { id: true, creationRequestHash: true },
    });
    ids[key] = { id: created.id, datasetId: dataset.id, jobId: job.id };
    return created;
  }
  const read = (key: string) => db.preparedImport.findUniqueOrThrow({ where: { id: ids[key].id }, select: { id: true, creationRequestHash: true, status: true, committedAt: true } });

  await t.test("lifecycle row: create A -> read -> update B -> read -> update null -> read", async () => {
    const created = await makeRow("k-lifecycle", { hash: VA });
    const typed: string | null = created.creationRequestHash; // compile-time: the generated type is string | null
    assert.equal(typed, VA);
    assert.equal((await read("k-lifecycle")).creationRequestHash, VA);
    const updated = await db.preparedImport.update({ where: { id: ids["k-lifecycle"].id }, data: { creationRequestHash: VB }, select: { creationRequestHash: true } });
    assert.equal(updated.creationRequestHash, VB);
    assert.equal((await read("k-lifecycle")).creationRequestHash, VB);
    const cleared = await db.preparedImport.update({ where: { id: ids["k-lifecycle"].id }, data: { creationRequestHash: null }, select: { creationRequestHash: true } });
    assert.equal(cleared.creationRequestHash, null);
    assert.equal((await read("k-lifecycle")).creationRequestHash, null);
  });

  await t.test("omitted field stores NULL", async () => {
    const created = await makeRow("k-omitted");
    assert.equal(created.creationRequestHash, null);
    assert.equal((await read("k-omitted")).creationRequestHash, null);
  });

  await t.test("duplicate non-null values are accepted (no uniqueness) and the remaining fixture rows are created", async () => {
    assert.equal((await makeRow("k-dup1", { hash: VB })).creationRequestHash, VB);
    assert.equal((await makeRow("k-dup2", { hash: VB })).creationRequestHash, VB);
    assert.equal((await makeRow("k-extra", { hash: VC, items: 2 })).creationRequestHash, VC);
    assert.notEqual(ids["k-dup1"].id, ids["k-dup2"].id);
  });

  const keysOf = (rows: Array<{ idempotencyKey: string }>) => rows.map((row) => row.idempotencyKey).sort();
  const mine = { createdById: owner.id };
  const select = { idempotencyKey: true, creationRequestHash: true } as const;

  await t.test("equality / null / not-null / duplicate-value filters have exact expected results", async () => {
    assert.equal(await db.preparedImport.count({ where: mine }), 5);
    assert.deepEqual(keysOf(await db.preparedImport.findMany({ where: { ...mine, creationRequestHash: VB }, select })), ["k-dup1", "k-dup2"]); // the lifecycle row no longer holds VB
    assert.equal(await db.preparedImport.count({ where: { ...mine, creationRequestHash: VA } }), 0); // and its old value A is gone
    assert.deepEqual(keysOf(await db.preparedImport.findMany({ where: { ...mine, creationRequestHash: VC }, select })), ["k-extra"]);
    assert.deepEqual(keysOf(await db.preparedImport.findMany({ where: { ...mine, creationRequestHash: null }, select })), ["k-lifecycle", "k-omitted"]);
    assert.equal(await db.preparedImport.count({ where: { ...mine, creationRequestHash: null } }), 2);
    assert.deepEqual(keysOf(await db.preparedImport.findMany({ where: { ...mine, creationRequestHash: { not: null } }, select })), ["k-dup1", "k-dup2", "k-extra"]);
    assert.equal(await db.preparedImport.count({ where: { ...mine, creationRequestHash: { not: null } } }), 3);
    assert.equal(await db.preparedImport.count({ where: { ...mine, creationRequestHash: { in: [VB, VC] } } }), 3);
    assert.equal(await db.preparedImport.count({ where: { ...mine, creationRequestHash: { startsWith: "compat-B-" } } }), 2);
    assert.equal((await db.preparedImport.aggregate({ where: mine, _count: { creationRequestHash: true } }))._count.creationRequestHash, 3); // counts non-null values only
  });

  await t.test("select projection returns the exact final state", async () => {
    const rows = await db.preparedImport.findMany({ where: mine, select, orderBy: { idempotencyKey: "asc" } });
    assert.deepEqual(rows, [
      { idempotencyKey: "k-dup1", creationRequestHash: VB }, { idempotencyKey: "k-dup2", creationRequestHash: VB }, { idempotencyKey: "k-extra", creationRequestHash: VC },
      { idempotencyKey: "k-lifecycle", creationRequestHash: null }, { idempotencyKey: "k-omitted", creationRequestHash: null },
    ]);
  });

  await t.test("orderBy executes on the field (restricted to non-null values with a deterministic secondary key; NULL ordering is not part of this contract)", async () => {
    const notNull = { ...mine, creationRequestHash: { not: null } } as const;
    const ascending = await db.preparedImport.findMany({ where: notNull, select, orderBy: [{ creationRequestHash: "asc" }, { idempotencyKey: "asc" }] });
    assert.deepEqual(ascending.map((row) => row.idempotencyKey), ["k-dup1", "k-dup2", "k-extra"]);
    const descending = await db.preparedImport.findMany({ where: notNull, select, orderBy: [{ creationRequestHash: "desc" }, { idempotencyKey: "asc" }] });
    assert.deepEqual(descending.map((row) => row.idempotencyKey), ["k-extra", "k-dup1", "k-dup2"]);
  });

  await t.test("existing composite unique lookup works with the new field selected", async () => {
    const dup1 = await db.preparedImport.findUnique({ where: { createdById_idempotencyKey: { createdById: owner.id, idempotencyKey: "k-dup1" } }, select: { id: true, creationRequestHash: true } });
    assert.deepEqual(dup1, { id: ids["k-dup1"].id, creationRequestHash: VB });
    const lifecycle = await db.preparedImport.findUnique({ where: { createdById_idempotencyKey: { createdById: owner.id, idempotencyKey: "k-lifecycle" } }, select: { id: true, creationRequestHash: true } });
    assert.deepEqual(lifecycle, { id: ids["k-lifecycle"].id, creationRequestHash: null });
  });

  await t.test("an existing field can be updated without disturbing the hash, and combines with it in a filter", async () => {
    const committedAt = new Date("2029-06-01T12:00:00.000Z");
    const updated = await db.preparedImport.update({ where: { id: ids["k-dup2"].id }, data: { status: PreparedImportStatus.COMMITTED, committedAt }, select: { status: true, committedAt: true, creationRequestHash: true } });
    assert.deepEqual(updated, { status: PreparedImportStatus.COMMITTED, committedAt, creationRequestHash: VB });
    assert.equal(await db.preparedImport.count({ where: { ...mine, creationRequestHash: VB } }), 2, "the equality count is unchanged");
    assert.deepEqual(keysOf(await db.preparedImport.findMany({ where: { ...mine, status: PreparedImportStatus.COMMITTED, creationRequestHash: VB }, select })), ["k-dup2"]);
  });

  await t.test("nested PreparedImportItem rows, Dataset/Job/User relations and _count behave with the new field present", async () => {
    const extra = await db.preparedImport.findUniqueOrThrow({
      where: { id: ids["k-extra"].id },
      include: { items: { orderBy: { position: "asc" } }, dataset: true, job: true, createdBy: true, _count: { select: { items: true } } },
    });
    assert.equal(extra.creationRequestHash, VC);
    assert.deepEqual(extra.items.map((item) => item.position), [0, 1]);
    assert.ok(extra.items.every((item) => item.preparedImportId === extra.id));
    assert.equal(extra._count.items, 2);
    assert.equal(extra.dataset.id, ids["k-extra"].datasetId); assert.equal(extra.job.id, ids["k-extra"].jobId); assert.equal(extra.createdBy.id, owner.id);
    await db.preparedImportItem.update({ where: { id: extra.items[0].id }, data: { completedAt: new Date("2029-06-01T12:00:00.000Z") } });
    await db.preparedImportItem.create({ data: { preparedImportId: extra.id, position: 2, logicalPath: "compat/k-extra/2.bin", normalizedPath: "compat/k-extra/2.bin", filename: "2.bin", mimeType: "application/octet-stream", sizeBytes: BigInt(3), modality: Modality.IMAGE, fingerprint: "fp-k-extra-2", storageKey: "compat/k-extra/2" } });
    const again = await db.preparedImport.findUniqueOrThrow({ where: { id: extra.id }, select: { creationRequestHash: true, _count: { select: { items: true } } } });
    assert.deepEqual(again, { creationRequestHash: VC, _count: { items: 3 } });
    const fromUser = await db.user.findUniqueOrThrow({ where: { id: owner.id }, select: { _count: { select: { preparedImports: true } }, preparedImports: { where: { creationRequestHash: VC }, select: { id: true } } } });
    assert.equal(fromUser._count.preparedImports, 5); assert.deepEqual(fromUser.preparedImports, [{ id: extra.id }]);
    const fromDataset = await db.dataset.findUniqueOrThrow({ where: { id: ids["k-dup1"].datasetId }, select: { preparedImports: { select: { creationRequestHash: true } } } });
    assert.deepEqual(fromDataset.preparedImports, [{ creationRequestHash: VB }]);
    const fromJob = await db.job.findUniqueOrThrow({ where: { id: ids["k-lifecycle"].jobId }, select: { preparedImport: { select: { creationRequestHash: true, idempotencyKey: true } } } });
    assert.deepEqual(fromJob.preparedImport, { creationRequestHash: null, idempotencyKey: "k-lifecycle" });
  });

  await t.test("generated runtime model: nullable scalar String, placed right after idempotencyKey", () => {
    const runtime = (db as unknown as { _runtimeDataModel: { models: Record<string, { fields: Array<Record<string, unknown>> }> } })._runtimeDataModel;
    const fields = runtime.models.PreparedImport.fields;
    const field = fields.find((candidate) => candidate.name === "creationRequestHash");
    assert.ok(field, "the runtime model exposes creationRequestHash");
    assert.deepEqual({ kind: field.kind, type: field.type, isRequired: field.isRequired, isList: field.isList, isUnique: field.isUnique, isId: field.isId, hasDefaultValue: field.hasDefaultValue, isReadOnly: field.isReadOnly, isGenerated: field.isGenerated, isUpdatedAt: field.isUpdatedAt },
      { kind: "scalar", type: "String", isRequired: false, isList: false, isUnique: false, isId: false, hasDefaultValue: false, isReadOnly: false, isGenerated: false, isUpdatedAt: false });
    const names = fields.map((candidate) => candidate.name);
    assert.equal(names.indexOf("creationRequestHash"), names.indexOf("idempotencyKey") + 1);
  });

  await t.test("server and browser scalar-field enums contain the field", () => {
    assert.equal(Prisma.PreparedImportScalarFieldEnum.creationRequestHash, "creationRequestHash");
    assert.equal(BrowserPrisma.PreparedImportScalarFieldEnum.creationRequestHash, "creationRequestHash");
    assert.deepEqual(Object.keys(Prisma.PreparedImportScalarFieldEnum), Object.keys(BrowserPrisma.PreparedImportScalarFieldEnum));
    for (const name of FIELDS) assert.ok(name in Prisma.PreparedImportScalarFieldEnum, name);
  });
});
