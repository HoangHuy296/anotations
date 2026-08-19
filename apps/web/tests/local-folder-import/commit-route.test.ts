import assert from "node:assert/strict";
import test from "node:test";

import { AssetStatus, DatasetSourceMode, Modality, StorageProvider } from "@internal/db";

import { commitLocalFolderImport } from "@/lib/imports/commit-local-folder-import";
import { db } from "@/lib/db";
import { hasImportIntegration, createPreparedImportFixture, createPreparedImportItemFixture } from "./helpers";
// Cross-app integration import, same established pattern as
// apps/web/tests/job-queue/recovery-scanner.test.ts importing the worker's
// recovery-scanner.js — the import commit-timeout detector
// (021-production-hardening-garbage-collection, User Story 3) lives in
// apps/worker but must be raced against apps/web's own commit path here.
import { failExpiredPreparedImports } from "../../../worker/src/queue/import-timeout-scanner.js";

async function publishFixtureAsset(datasetId: string, ownerId: string, key: string) {
  return db.asset.create({ data: { datasetId, uploadedById: ownerId, modality: Modality.TEXT, filename: "item.txt", mimeType: "text/plain", sourceMode: DatasetSourceMode.UPLOAD, storageProvider: StorageProvider.MINIO, storageBucket: "test", storageKey: key, sourceFingerprint: key, status: AssetStatus.READY, textAsset: { create: { tokenization: {}, metadata: {} } } }, select: { id: true } });
}

test("incomplete import commit is rejected without database or event side effects", { skip: !hasImportIntegration }, async () => {
  const fixture = await createPreparedImportFixture({ expectedItemCount: 2 });
  try {
    await createPreparedImportItemFixture(fixture.preparedImport.id, { position: 0 });
    await createPreparedImportItemFixture(fixture.preparedImport.id, { position: 1 });
    const before = await Promise.all([db.job.findUniqueOrThrow({ where: { id: fixture.job.id }, select: { status: true, updatedAt: true } }), db.jobEvent.count({ where: { jobId: fixture.job.id } }), db.asset.count({ where: { datasetId: fixture.dataset.id } })]);
    const result = await commitLocalFolderImport(fixture.owner, fixture.job.id);
    const after = await Promise.all([db.job.findUniqueOrThrow({ where: { id: fixture.job.id }, select: { status: true, updatedAt: true } }), db.jobEvent.count({ where: { jobId: fixture.job.id } }), db.asset.count({ where: { datasetId: fixture.dataset.id } })]);
    assert.equal(result.ok, false); assert.equal("code" in result && result.code, "IMPORT_INCOMPLETE");
    assert.deepEqual(after, before);
  } finally { await fixture.cleanup(); }
});

test("simultaneous complete commits produce one terminal transition and one event", { skip: !hasImportIntegration }, async () => {
  const fixture = await createPreparedImportFixture();
  try {
    const item = await createPreparedImportItemFixture(fixture.preparedImport.id);
    const asset = await publishFixtureAsset(fixture.dataset.id, fixture.owner.id, `asset-${item.id}`);
    await db.preparedImportItem.update({ where: { id: item.id }, data: { assetId: asset.id, completedAt: new Date() } });
    const [one, two] = await Promise.all([commitLocalFolderImport(fixture.owner, fixture.job.id), commitLocalFolderImport(fixture.owner, fixture.job.id)]);
    assert.equal(one.ok, true); assert.equal(two.ok, true);
    assert.equal(await db.jobEvent.count({ where: { jobId: fixture.job.id, message: "IMPORT_COMMITTED" } }), 1);
    assert.equal(await db.asset.count({ where: { datasetId: fixture.dataset.id } }), 1);
    const job = await db.job.findUniqueOrThrow({ where: { id: fixture.job.id }, select: { status: true } });
    assert.equal(job.status, "COMPLETED");
  } finally { await fixture.cleanup(); }
});

// 021-production-hardening-garbage-collection, User Story 3.

test("commit arrives before the deadline: the timeout scanner takes no action on an already-committed import", { skip: !hasImportIntegration }, async () => {
  const fixture = await createPreparedImportFixture({ deadlineAt: new Date(Date.now() + 60_000) });
  try {
    const item = await createPreparedImportItemFixture(fixture.preparedImport.id);
    const asset = await publishFixtureAsset(fixture.dataset.id, fixture.owner.id, `asset-${item.id}`);
    await db.preparedImportItem.update({ where: { id: item.id }, data: { assetId: asset.id, completedAt: new Date() } });

    const committed = await commitLocalFolderImport(fixture.owner, fixture.job.id);
    assert.equal(committed.ok, true);

    const failedCount = await failExpiredPreparedImports(db);
    assert.equal(failedCount, 0, "the scanner must not touch an import that already committed before its deadline");

    const job = await db.job.findUniqueOrThrow({ where: { id: fixture.job.id }, select: { status: true, errorCode: true } });
    assert.deepEqual(job, { status: "COMPLETED", errorCode: null });
    const preparedImport = await db.preparedImport.findUniqueOrThrow({ where: { id: fixture.preparedImport.id }, select: { status: true } });
    assert.equal(preparedImport.status, "COMMITTED");
    assert.equal(await db.jobEvent.count({ where: { jobId: fixture.job.id, message: "JOB_FAILED" } }), 0);
  } finally { await fixture.cleanup(); }
});

test("a commit racing the exact timeout-deadline moment never reports success unless the Job truly is COMPLETED", { skip: !hasImportIntegration }, async () => {
  // Deliberately tight: past enough that the scanner's SQL-side `NOW()` may
  // already see it as expired by the time either transaction's statements
  // actually execute, but close enough to the moment this test starts that
  // commitLocalFolderImport's own (pre-transaction) status read still sees
  // the Job as RUNNING — the exact narrow window a naive "0 rows updated =>
  // already committed by someone else" assumption gets wrong (see the fix
  // in commit-local-folder-import.ts). The assertions below hold under
  // either interleaving, so this is not a flaky "expect a specific winner"
  // test — it is a "the response must never lie" test.
  const fixture = await createPreparedImportFixture({ deadlineAt: new Date(Date.now() + 15) });
  try {
    const item = await createPreparedImportItemFixture(fixture.preparedImport.id);
    const asset = await publishFixtureAsset(fixture.dataset.id, fixture.owner.id, `asset-${item.id}`);
    await db.preparedImportItem.update({ where: { id: item.id }, data: { assetId: asset.id, completedAt: new Date() } });

    const [commitResult] = await Promise.all([
      commitLocalFolderImport(fixture.owner, fixture.job.id),
      failExpiredPreparedImports(db),
    ]);

    const job = await db.job.findUniqueOrThrow({ where: { id: fixture.job.id }, select: { status: true, errorCode: true } });
    // Exactly one terminal outcome — never both, never neither.
    assert.ok(job.status === "COMPLETED" || job.status === "FAILED", `expected a single terminal outcome, got ${job.status}`);
    if (commitResult.ok) {
      assert.equal(job.status, "COMPLETED", "a success response must correspond to an actually-COMPLETED Job — never one the scanner failed out from under it");
    } else {
      assert.equal(job.status, "FAILED");
      assert.equal(job.errorCode, "IMPORT_COMMIT_TIMEOUT");
    }
  } finally { await fixture.cleanup(); }
});
