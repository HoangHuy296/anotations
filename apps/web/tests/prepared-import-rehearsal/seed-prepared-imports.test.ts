import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { DatasetSourceMode, JobStatus, JobType, Modality, PreparedImportStatus, UserRole } from "@internal/db";

import { db } from "@/lib/db";

/**
 * Migration-25 rehearsal fixture (REHEARSAL-ONLY; invoked solely by `rehearse:prepared-import-creation-request-hash`
 * through its internal catalog entry, never as a general test). It runs when the disposable database is at migration 24
 * and creates three representative PreparedImport rows (PREPARING / COMMITTED / EXPIRED), each with child items, through the
 * existing generated client, which predates PreparedImport.creationRequestHash. The orchestrator fingerprints these rows
 * before migration 25 and proves they are unchanged afterwards (new column NULL, nothing else touched).
 * Fixed values only: no secrets, no source bytes.
 */
const ROWS = [
  { key: "m25-rehearsal-preparing", status: PreparedImportStatus.PREPARING, modality: Modality.IMAGE, committedAt: null, deadlineAt: new Date("2030-01-01T00:00:00.000Z"), items: 2 },
  { key: "m25-rehearsal-committed", status: PreparedImportStatus.COMMITTED, modality: Modality.TEXT, committedAt: new Date("2029-06-01T12:00:00.000Z"), deadlineAt: new Date("2029-06-01T13:00:00.000Z"), items: 1 },
  { key: "m25-rehearsal-expired", status: PreparedImportStatus.EXPIRED, modality: Modality.VIDEO, committedAt: null, deadlineAt: new Date("2020-01-01T00:00:00.000Z"), items: 3 },
] as const;

test("creates exactly three representative PreparedImport rows with child items at migration 24", async () => {
  assert.equal(await db.preparedImport.count(), 0, "the disposable database must start without PreparedImport rows");
  const owner = await db.user.create({ data: { email: "m25-rehearsal@test.invalid", name: "m25-rehearsal", role: UserRole.MANAGER }, select: { id: true } });
  for (const row of ROWS) {
    const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: row.key, modality: row.modality, primaryModality: row.modality, modalityResolverSubject: owner.id, sourceMode: DatasetSourceMode.UPLOAD }, select: { id: true } });
    const job = await db.job.create({ data: { datasetId: dataset.id, createdById: owner.id, type: JobType.IMPORT_DATASET, status: JobStatus.RUNNING, totalItems: row.items, input: {} }, select: { id: true } });
    const prepared = await db.preparedImport.create({ data: { datasetId: dataset.id, jobId: job.id, createdById: owner.id, expectedItemCount: row.items, deadlineAt: row.deadlineAt, committedAt: row.committedAt, status: row.status, idempotencyKey: row.key }, select: { id: true } });
    for (let position = 0; position < row.items; position += 1) {
      const logicalPath = `rehearsal/${row.key}/item-${position}.bin`;
      await db.preparedImportItem.create({ data: { preparedImportId: prepared.id, position, logicalPath, normalizedPath: logicalPath, filename: `item-${position}.bin`, mimeType: "application/octet-stream", sizeBytes: BigInt(position + 1), modality: row.modality, fingerprint: createHash("sha256").update(logicalPath).digest("hex"), storageKey: `rehearsal/${prepared.id}/${position}` } });
    }
  }
  assert.equal(await db.preparedImport.count(), 3);
  assert.equal(await db.preparedImportItem.count(), 6);
  assert.deepEqual((await db.preparedImport.findMany({ select: { status: true }, orderBy: { idempotencyKey: "asc" } })).map((row) => row.status), ["COMMITTED", "EXPIRED", "PREPARING"]);
});
