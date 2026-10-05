import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createWorkerDatabase } from "../../src/providers/db.js";
import { getWorkerConfig } from "../../src/config.js";
import { captureIdentity, VISUALIZATION_CAPTURE_ALGORITHM, type SnapshotDescriptor } from "@annotationplatform/domain/visualization-processing";
import { publishVisualization, readCapture } from "../../src/jobs/visualization.processor.js";

async function fixture() {
  const db = createWorkerDatabase(getWorkerConfig());
  const user = await db.user.create({ data: { email: `vis4-${randomUUID()}@test.invalid`, role: "MANAGER" } });
  const dataset = await db.dataset.create({ data: { ownerId: user.id, name: "Generation fixture", metadata: { workflowStatus: "COMPLETED" } } });
  const asset = await db.asset.create({ data: { datasetId: dataset.id, filename: "image.png", modality: "IMAGE", mimeType: "image/png", sourceFingerprint: randomUUID(), width: 100, height: 50 } });
  const label = await db.label.create({ data: { datasetId: dataset.id, name: "Car", normalizedName: "car", color: "#123456" } });
  const annotation = await db.annotation.create({ data: { datasetId: dataset.id, assetId: asset.id, labelId: label.id, createdById: user.id, modality: "IMAGE", type: "BOUNDING_BOX", geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } } });
  const generation = async () => (await db.dataset.findUniqueOrThrow({ where: { id: dataset.id } })).visualizationGeneration;
  const candidate = async () => {
    const gen = await generation();
    const capture = await readCapture(db, dataset.id, gen);
    const content = { dataset: capture.dataset, assets: [], annotations: [], labels: capture.labels };
    const descriptor: SnapshotDescriptor = { schemaVersion: 1, generation: gen.toString(), algorithm: VISUALIZATION_CAPTURE_ALGORITHM, content, ...captureIdentity(dataset.id, gen.toString(), content) };
    const job = await db.job.create({ data: { datasetId: dataset.id, createdById: user.id, type: "VISUALIZATION_CAPTURE", status: "RUNNING", lockToken: randomUUID(), lockedUntil: new Date(Date.now() + 60000), input: {} } });
    return { datasetId: dataset.id, generation: gen, jobId: job.id, lockToken: job.lockToken!, snapshotId: descriptor.snapshotId, descriptor, artifacts: [] };
  };
  return { db, user, dataset, asset, label, annotation, generation, candidate, cleanup: async () => { await db.dataset.delete({ where: { id: dataset.id } }); await db.user.delete({ where: { id: user.id } }); await db.$disconnect(); } };
}

test("database triggers advance exactly once per relevant row; unrelated/no-op writes and transaction rollback do not", async () => {
  const f = await fixture(); const { db, dataset, asset, label, annotation } = f;
  try {
    assert.equal(await f.generation(), 3n);
    const unchanged = await f.generation();
    await db.dataset.update({ where: { id: dataset.id }, data: { metadata: { workflowStatus: "COMPLETED", displayPreference: true }, visualizationPublicationFence: { increment: 1 } } });
    await db.asset.update({ where: { id: asset.id }, data: { filename: asset.filename, status: "COMPLETED", metadata: { arbitrary: "ignored" } } });
    await db.label.update({ where: { id: label.id }, data: { color: label.color, normalizedName: "search-only" } });
    await db.annotation.update({ where: { id: annotation.id }, data: { geometry: { height: 0.2, width: 0.2, y: 0.1, x: 0.1 } } });
    assert.equal(await f.generation(), unchanged);
    const relevant = [
      () => db.dataset.update({ where: { id: dataset.id }, data: { name: "Renamed" } }),
      () => db.asset.update({ where: { id: asset.id }, data: { width: 200 } }),
      () => db.annotation.update({ where: { id: annotation.id }, data: { revision: { increment: 1 }, geometry: { x: 0.2, y: 0.2, width: 0.3, height: 0.3 } } }),
      () => db.label.update({ where: { id: label.id }, data: { color: "#abcdef" } }),
      () => db.asset.update({ where: { id: asset.id }, data: { archivedAt: new Date() } }),
      () => db.asset.update({ where: { id: asset.id }, data: { archivedAt: null } }),
      () => db.dataset.update({ where: { id: dataset.id }, data: { metadata: { workflowStatus: "IN_PROGRESS" } } }),
      () => db.dataset.update({ where: { id: dataset.id }, data: { metadata: { workflowStatus: "COMPLETED" } } }),
    ];
    for (const change of relevant) { const before = await f.generation(); await change(); assert.equal(await f.generation(), before + 1n); }
    const before = await f.generation();
    await assert.rejects(db.$transaction(async tx => { await tx.label.update({ where: { id: label.id }, data: { name: "Rolled back" } }); throw new Error("rollback"); }));
    assert.equal(await f.generation(), before);
    await db.annotation.delete({ where: { id: annotation.id } }); assert.equal(await f.generation(), before + 1n);
    await db.label.delete({ where: { id: label.id } }); assert.equal(await f.generation(), before + 2n);
    await db.asset.delete({ where: { id: asset.id } }); assert.equal(await f.generation(), before + 3n);
  } finally { await f.cleanup(); }
});

test("concurrent writes serialize generation increments without lost updates", async () => {
  const f = await fixture();
  try {
    const before = await f.generation();
    await Promise.all(Array.from({ length: 8 }, (_, i) => f.db.label.create({ data: { datasetId: f.dataset.id, name: `Label ${i}`, normalizedName: `label-${i}`, color: "#123456" } })));
    assert.equal(await f.generation(), before + 8n);
  } finally { await f.cleanup(); }
});

test("publication refuses annotation/label/asset changes, reopen, archive and delete; old immutable snapshots survive", async () => {
  const f = await fixture();
  try {
    const first = await f.candidate(); await publishVisualization(f.db, first);
    assert.equal(await f.db.datasetSnapshot.count({ where: { datasetId: f.dataset.id } }), 1);
    await assert.rejects(publishVisualization(f.db, first)); // Duplicate terminal lease cannot publish twice.
    await assert.rejects(f.db.datasetSnapshot.update({ where: { id: first.snapshotId }, data: { annotationCount: 99 } }));
    await assert.rejects(f.db.datasetSnapshot.delete({ where: { id: first.snapshotId } }));
    const changes = [
      () => f.db.annotation.update({ where: { id: f.annotation.id }, data: { revision: { increment: 1 } } }),
      () => f.db.label.update({ where: { id: f.label.id }, data: { color: "#abcdef" } }),
      () => f.db.asset.create({ data: { datasetId: f.dataset.id, filename: "added.png", mimeType: "image/png", modality: "IMAGE", sourceFingerprint: randomUUID() } }),
      () => f.db.asset.update({ where: { id: f.asset.id }, data: { deletedAt: new Date() } }),
      () => f.db.dataset.update({ where: { id: f.dataset.id }, data: { metadata: { workflowStatus: "IN_PROGRESS" } } }),
    ];
    for (const change of changes) {
      const pending = await f.candidate(); await change();
      await assert.rejects(publishVisualization(f.db, pending));
      assert.equal((await f.db.dataset.findUniqueOrThrow({ where: { id: f.dataset.id } })).visualizationCurrentSnapshotId, first.snapshotId);
      assert.equal(await f.db.datasetSnapshot.count({ where: { datasetId: f.dataset.id } }), 1);
    }
    await f.db.dataset.update({ where: { id: f.dataset.id }, data: { metadata: { workflowStatus: "COMPLETED" } } });
    for (const field of ["archivedAt", "deletedAt"] as const) {
      const pending = await f.candidate(); await f.db.dataset.update({ where: { id: f.dataset.id }, data: { [field]: new Date() } });
      await assert.rejects(publishVisualization(f.db, pending));
      await f.db.dataset.update({ where: { id: f.dataset.id }, data: { [field]: null } });
    }
    const second = await f.candidate(); await publishVisualization(f.db, second);
    assert.deepEqual((await f.db.datasetSnapshot.findMany({ where: { datasetId: f.dataset.id }, orderBy: { ordinal: "asc" } })).map(s => s.ordinal), [1, 2]);
  } finally { await f.cleanup(); }
});

test("an uncommitted source change holds the publication fence until commit", async () => {
  const f = await fixture();
  try {
    const pending = await f.candidate();
    let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
    let locked!: () => void; const lock = new Promise<void>(resolve => { locked = resolve; });
    const write = f.db.$transaction(async tx => { await tx.label.update({ where: { id: f.label.id }, data: { name: "Concurrent edit" } }); locked(); await wait; });
    await lock;
    const publication = publishVisualization(f.db, pending);
    const rejection = assert.rejects(publication);
    release(); await write; await rejection;
    assert.equal(await f.db.datasetSnapshot.count({ where: { datasetId: f.dataset.id } }), 0);
  } finally { await f.cleanup(); }
});

test("concurrent same-generation publishers reuse one snapshot and one derivation Job", async () => {
  const f = await fixture();
  try {
    const a = await f.candidate(), b = await f.candidate();
    assert.equal(a.snapshotId, b.snapshotId);
    await Promise.all([publishVisualization(f.db, a), publishVisualization(f.db, b)]);
    assert.equal(await f.db.datasetSnapshot.count({ where: { datasetId: f.dataset.id } }), 1);
    assert.equal(await f.db.job.count({ where: { datasetId: f.dataset.id, type: "VISUALIZATION_DERIVE" } }), 1);
    const expired = await f.candidate();
    await f.db.job.update({ where: { id: expired.jobId }, data: { lockedUntil: new Date(0) } });
    await assert.rejects(publishVisualization(f.db, expired));
    const canceled = await f.candidate();
    await f.db.job.update({ where: { id: canceled.jobId }, data: { cancelRequestedAt: new Date() } });
    await assert.rejects(publishVisualization(f.db, canceled));
    assert.equal(await f.db.datasetSnapshot.count({ where: { datasetId: f.dataset.id } }), 1);
  } finally { await f.cleanup(); }
});
