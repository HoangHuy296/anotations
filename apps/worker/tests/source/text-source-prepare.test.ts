import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { getWorkerConfig } from "../../src/config.js";
import { createWorkerDatabase } from "../../src/providers/db.js";
import { createWorkerMinio } from "../../src/providers/minio.js";
import { claimJob } from "../../src/jobs/job-claim-lock.js";
import { processTextSourcePrepare } from "../../src/jobs/text-source-prepare.processor.js";
import { textBoundaryArtifactObjectKey } from "../../src/source/text-boundary.js";

const enabled = Boolean(process.env.DATABASE_URL && process.env.MINIO_ENDPOINT && process.env.MINIO_ACCESS_KEY);
const skip = "TEXT_SOURCE_PREPARE worker integration skipped: PostgreSQL/MinIO configuration is unavailable";

const unique = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function seedFixture(db: ReturnType<typeof createWorkerDatabase>) {
  const suffix = unique("text-prepare");
  const owner = await db.user.create({ data: { email: `${suffix}@phase025.test`, role: "MANAGER" }, select: { id: true } });
  const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: suffix }, select: { id: true } });
  return { ownerId: owner.id, datasetId: dataset.id, suffix };
}

async function seedAsset(db: ReturnType<typeof createWorkerDatabase>, input: { datasetId: string; storageBucket: string; storageKey: string; checksum: string; sizeBytes: number }) {
  return db.asset.create({
    data: {
      datasetId: input.datasetId,
      modality: "TEXT",
      filename: "source.txt",
      mimeType: "text/plain",
      storageProvider: "MINIO",
      storageBucket: input.storageBucket,
      storageKey: input.storageKey,
      checksum: input.checksum,
      sizeBytes: BigInt(input.sizeBytes),
      sourceFingerprint: unique("asset"),
    },
    select: { id: true, storageBucket: true, storageKey: true, checksum: true, sizeBytes: true },
  });
}

async function createPrepareJob(db: ReturnType<typeof createWorkerDatabase>, input: { datasetId: string; ownerId: string; assetId: string; expectedSource: { storageBucket: string; storageKey: string; checksum: string | null; sizeBytes: string | null } }) {
  return db.job.create({
    data: {
      datasetId: input.datasetId,
      createdById: input.ownerId,
      type: "TEXT_SOURCE_PREPARE",
      status: "QUEUED",
      input: {
        actorId: input.ownerId,
        datasetId: input.datasetId,
        assetId: input.assetId,
        mode: "OBJECT_SOURCE",
        expectedSource: input.expectedSource,
      },
    },
    select: { id: true },
  });
}

async function claimAndRun(db: ReturnType<typeof createWorkerDatabase>, jobId: string) {
  const claim = await claimJob(db, { jobId, workerId: unique("worker") });
  assert.equal(claim.kind, "claimed");
  if (claim.kind !== "claimed") throw new Error("unreachable");
  return { lockToken: claim.lockToken, result: await processTextSourcePrepare(db, jobId, claim.lockToken) };
}

// research.md D1 fixture table.
const unicodeFixtures: Array<{ name: string; text: string; codeUnitLength: number }> = [
  { name: "ascii sentence", text: "OpenAI builds AI.", codeUnitLength: 17 },
  { name: "surrogate-pair emoji", text: "A\u{1F600}B", codeUnitLength: 4 },
  { name: "combining mark", text: "é", codeUnitLength: 2 },
  { name: "ZWJ emoji sequence", text: "\u{1F469}‍\u{1F4BB}", codeUnitLength: 5 },
  { name: "BOM + mixed line endings", text: "﻿A\r\nB\rC\n", codeUnitLength: 8 },
  { name: "empty string", text: "", codeUnitLength: 0 },
];

for (const fixture of unicodeFixtures) {
  test(enabled ? `processTextSourcePrepare: ${fixture.name} completes and persists exactly the verified metadata` : skip, { skip: !enabled }, async (t) => {
    const db = createWorkerDatabase(getWorkerConfig());
    const config = getWorkerConfig();
    const minio = createWorkerMinio(config);
    const { ownerId, datasetId, suffix } = await seedFixture(db);
    const storageKey = `text-sources/__test-fixtures__/${suffix}/source.txt`;
    const bytes = Buffer.from(fixture.text, "utf8");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    await minio.putObject(config.MINIO_BUCKET, storageKey, bytes, bytes.length, { "Content-Type": "text/plain" });
    const asset = await seedAsset(db, { datasetId, storageBucket: config.MINIO_BUCKET, storageKey, checksum, sizeBytes: bytes.length });
    const job = await createPrepareJob(db, { datasetId, ownerId, assetId: asset.id, expectedSource: { storageBucket: config.MINIO_BUCKET, storageKey, checksum, sizeBytes: String(bytes.length) } });

    let artifactKey: string | undefined;
    t.after(async () => {
      await minio.removeObject(config.MINIO_BUCKET, storageKey).catch(() => undefined);
      if (artifactKey) await minio.removeObject(config.MINIO_BUCKET, artifactKey).catch(() => undefined);
      await db.annotationMutationReceipt.deleteMany({ where: { assetId: asset.id } });
      await db.job.deleteMany({ where: { datasetId } });
      await db.asset.deleteMany({ where: { datasetId } });
      await db.dataset.delete({ where: { id: datasetId } });
      await db.user.delete({ where: { id: ownerId } });
      await db.$disconnect();
    });

    const { result } = await claimAndRun(db, job.id);
    assert.equal(result, "completed");

    const textAsset = await db.textAsset.findUnique({ where: { assetId: asset.id } });
    assert.ok(textAsset);
    assert.equal(textAsset?.sourceEncoding, "UTF8");
    assert.equal(textAsset?.offsetUnit, "UTF16_CODE_UNIT");
    assert.equal(textAsset?.sourceCodeUnitLength, fixture.codeUnitLength);
    assert.equal(textAsset?.sourceByteLength, bytes.length);
    assert.match(textAsset?.sourceIdentity ?? "", /^sha256:[0-9a-f]{64}$/);
    artifactKey = textAsset?.boundaryArtifactKey ?? undefined;
    assert.equal(artifactKey, textBoundaryArtifactObjectKey({ datasetId, assetId: asset.id, sourceIdentity: textAsset!.sourceIdentity! }));

    // The web loader must consume exactly this worker-written artifact contract.
    const artifactObject = await minio.getObject(config.MINIO_BUCKET, artifactKey!);
    const artifactChunks: Buffer[] = [];
    for await (const chunk of artifactObject) artifactChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const artifactBytes = Buffer.concat(artifactChunks);
    const artifactDigest = `sha256:${createHash("sha256").update(artifactBytes).digest("hex")}`;
    assert.equal(artifactDigest, textAsset?.boundaryArtifactDigest);
    const parsedArtifact = JSON.parse(artifactBytes.toString("utf8"));
    assert.equal(parsedArtifact.sourceIdentity, textAsset?.sourceIdentity);
    assert.equal(parsedArtifact.boundaryOffsets[0], 0);
    assert.equal(parsedArtifact.boundaryOffsets.at(-1), fixture.codeUnitLength);

    const finishedJob = await db.job.findUnique({ where: { id: job.id }, select: { status: true } });
    assert.equal(finishedJob?.status, "COMPLETED");
  });
}

test(enabled ? "processTextSourcePrepare: a stale lockToken (simulated duplicate delivery loser) is refused with no side effects" : skip, { skip: !enabled }, async (t) => {
  const db = createWorkerDatabase(getWorkerConfig());
  const config = getWorkerConfig();
  const minio = createWorkerMinio(config);
  const { ownerId, datasetId, suffix } = await seedFixture(db);
  const storageKey = `text-sources/__test-fixtures__/${suffix}/source.txt`;
  const bytes = Buffer.from("duplicate delivery fixture", "utf8");
  const checksum = createHash("sha256").update(bytes).digest("hex");
  await minio.putObject(config.MINIO_BUCKET, storageKey, bytes, bytes.length, { "Content-Type": "text/plain" });
  const asset = await seedAsset(db, { datasetId, storageBucket: config.MINIO_BUCKET, storageKey, checksum, sizeBytes: bytes.length });
  const job = await createPrepareJob(db, { datasetId, ownerId, assetId: asset.id, expectedSource: { storageBucket: config.MINIO_BUCKET, storageKey, checksum, sizeBytes: String(bytes.length) } });

  t.after(async () => {
    await minio.removeObject(config.MINIO_BUCKET, storageKey).catch(() => undefined);
    await db.job.deleteMany({ where: { datasetId } });
    await db.asset.deleteMany({ where: { datasetId } });
    await db.dataset.delete({ where: { id: datasetId } });
    await db.user.delete({ where: { id: ownerId } });
    await db.$disconnect();
  });

  const claim = await claimJob(db, { jobId: job.id, workerId: unique("worker") });
  assert.equal(claim.kind, "claimed");
  // A redelivered message carrying a stale/wrong lock token must never process work.
  const loserResult = await processTextSourcePrepare(db, job.id, "not-the-real-lock-token");
  assert.equal(loserResult, "refused");
  const textAssetAfterLoser = await db.textAsset.findUnique({ where: { assetId: asset.id } });
  assert.equal(textAssetAfterLoser, null);

  if (claim.kind === "claimed") {
    const winnerResult = await processTextSourcePrepare(db, job.id, claim.lockToken);
    assert.equal(winnerResult, "completed");
    const textAssetAfterWinner = await db.textAsset.findUnique({ where: { assetId: asset.id } });
    assert.ok(textAssetAfterWinner);
    if (textAssetAfterWinner?.boundaryArtifactKey) await minio.removeObject(config.MINIO_BUCKET, textAssetAfterWinner.boundaryArtifactKey).catch(() => undefined);
  }
});

test(enabled ? "processTextSourcePrepare: a source replaced before processing starts fails with TEXT_SOURCE_STALE and leaves TextAsset unchanged" : skip, { skip: !enabled }, async (t) => {
  const db = createWorkerDatabase(getWorkerConfig());
  const config = getWorkerConfig();
  const minio = createWorkerMinio(config);
  const { ownerId, datasetId, suffix } = await seedFixture(db);
  const storageKey = `text-sources/__test-fixtures__/${suffix}/source.txt`;
  const bytes = Buffer.from("original bytes", "utf8");
  await minio.putObject(config.MINIO_BUCKET, storageKey, bytes, bytes.length, { "Content-Type": "text/plain" });
  const asset = await seedAsset(db, { datasetId, storageBucket: config.MINIO_BUCKET, storageKey, checksum: "stale-checksum-that-does-not-match", sizeBytes: bytes.length });
  const job = await createPrepareJob(db, { datasetId, ownerId, assetId: asset.id, expectedSource: { storageBucket: config.MINIO_BUCKET, storageKey, checksum: "stale-checksum-that-does-not-match", sizeBytes: String(bytes.length) } });

  t.after(async () => {
    await minio.removeObject(config.MINIO_BUCKET, storageKey).catch(() => undefined);
    await db.job.deleteMany({ where: { datasetId } });
    await db.asset.deleteMany({ where: { datasetId } });
    await db.dataset.delete({ where: { id: datasetId } });
    await db.user.delete({ where: { id: ownerId } });
    await db.$disconnect();
  });

  // Simulate the asset's checksum having moved on since the Job was enqueued.
  await db.asset.update({ where: { id: asset.id }, data: { checksum: "a-different-checksum-now" } });

  const { result } = await claimAndRun(db, job.id);
  assert.equal(result, "failed");
  const failedJob = await db.job.findUnique({ where: { id: job.id }, select: { status: true, errorCode: true } });
  assert.equal(failedJob?.status, "FAILED");
  assert.equal(failedJob?.errorCode, "TEXT_SOURCE_STALE");
  const textAsset = await db.textAsset.findUnique({ where: { assetId: asset.id } });
  assert.equal(textAsset, null);
});

test(enabled ? "processTextSourcePrepare: invalid UTF-8 fails safely with no TextAsset write" : skip, { skip: !enabled }, async (t) => {
  const db = createWorkerDatabase(getWorkerConfig());
  const config = getWorkerConfig();
  const minio = createWorkerMinio(config);
  const { ownerId, datasetId, suffix } = await seedFixture(db);
  const storageKey = `text-sources/__test-fixtures__/${suffix}/source.txt`;
  const bytes = Buffer.from([0x41, 0xff, 0x42]);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  await minio.putObject(config.MINIO_BUCKET, storageKey, bytes, bytes.length, { "Content-Type": "text/plain" });
  const asset = await seedAsset(db, { datasetId, storageBucket: config.MINIO_BUCKET, storageKey, checksum, sizeBytes: bytes.length });
  const job = await createPrepareJob(db, { datasetId, ownerId, assetId: asset.id, expectedSource: { storageBucket: config.MINIO_BUCKET, storageKey, checksum, sizeBytes: String(bytes.length) } });

  t.after(async () => {
    await minio.removeObject(config.MINIO_BUCKET, storageKey).catch(() => undefined);
    await db.job.deleteMany({ where: { datasetId } });
    await db.asset.deleteMany({ where: { datasetId } });
    await db.dataset.delete({ where: { id: datasetId } });
    await db.user.delete({ where: { id: ownerId } });
    await db.$disconnect();
  });

  const { result } = await claimAndRun(db, job.id);
  assert.equal(result, "failed");
  const failedJob = await db.job.findUnique({ where: { id: job.id }, select: { errorCode: true } });
  assert.equal(failedJob?.errorCode, "TEXT_SOURCE_INVALID_ENCODING");
  assert.equal(await db.textAsset.findUnique({ where: { assetId: asset.id } }), null);
});

test(enabled ? "processTextSourcePrepare: oversized source fails safely with TEXT_SOURCE_OVERSIZED_BYTES" : skip, { skip: !enabled }, async (t) => {
  const db = createWorkerDatabase(getWorkerConfig());
  const config = getWorkerConfig();
  const minio = createWorkerMinio(config);
  const { ownerId, datasetId, suffix } = await seedFixture(db);
  const storageKey = `text-sources/__test-fixtures__/${suffix}/source.txt`;
  const bytes = Buffer.alloc(2_000_000, "a");
  const checksum = createHash("sha256").update(bytes).digest("hex");
  await minio.putObject(config.MINIO_BUCKET, storageKey, bytes, bytes.length, { "Content-Type": "text/plain" });
  const asset = await seedAsset(db, { datasetId, storageBucket: config.MINIO_BUCKET, storageKey, checksum, sizeBytes: bytes.length });
  const job = await createPrepareJob(db, { datasetId, ownerId, assetId: asset.id, expectedSource: { storageBucket: config.MINIO_BUCKET, storageKey, checksum, sizeBytes: String(bytes.length) } });

  t.after(async () => {
    await minio.removeObject(config.MINIO_BUCKET, storageKey).catch(() => undefined);
    await db.job.deleteMany({ where: { datasetId } });
    await db.asset.deleteMany({ where: { datasetId } });
    await db.dataset.delete({ where: { id: datasetId } });
    await db.user.delete({ where: { id: ownerId } });
    await db.$disconnect();
  });

  const { result } = await claimAndRun(db, job.id);
  assert.equal(result, "failed");
  const failedJob = await db.job.findUnique({ where: { id: job.id }, select: { errorCode: true } });
  assert.equal(failedJob?.errorCode, "TEXT_SOURCE_OVERSIZED_BYTES");
  assert.equal(await db.textAsset.findUnique({ where: { assetId: asset.id } }), null);
});

test(enabled ? "processTextSourcePrepare: a successor Job created after a FAILED attempt completes and writes exactly one boundary artifact" : skip, { skip: !enabled }, async (t) => {
  const db = createWorkerDatabase(getWorkerConfig());
  const config = getWorkerConfig();
  const minio = createWorkerMinio(config);
  const { ownerId, datasetId, suffix } = await seedFixture(db);
  const storageKey = `text-sources/__test-fixtures__/${suffix}/source.txt`;
  const bytes = Buffer.from("successor retry fixture", "utf8");
  const checksum = createHash("sha256").update(bytes).digest("hex");
  await minio.putObject(config.MINIO_BUCKET, storageKey, bytes, bytes.length, { "Content-Type": "text/plain" });
  const asset = await seedAsset(db, { datasetId, storageBucket: config.MINIO_BUCKET, storageKey, checksum, sizeBytes: bytes.length });

  // First attempt: wrong expectedSource -> fails immediately (simulates an earlier bad enqueue).
  const failedJob = await createPrepareJob(db, { datasetId, ownerId, assetId: asset.id, expectedSource: { storageBucket: config.MINIO_BUCKET, storageKey, checksum: "wrong", sizeBytes: String(bytes.length) } });
  await claimAndRun(db, failedJob.id);

  // Successor: correct expectedSource, linked via retryOfJobId, following existing predecessor/successor Job rules.
  const successorJob = await db.job.create({
    data: {
      datasetId,
      createdById: ownerId,
      type: "TEXT_SOURCE_PREPARE",
      status: "QUEUED",
      retryOfJobId: failedJob.id,
      input: { actorId: ownerId, datasetId, assetId: asset.id, mode: "OBJECT_SOURCE", expectedSource: { storageBucket: config.MINIO_BUCKET, storageKey, checksum, sizeBytes: String(bytes.length) } },
    },
    select: { id: true },
  });

  let artifactKey: string | undefined;
  t.after(async () => {
    await minio.removeObject(config.MINIO_BUCKET, storageKey).catch(() => undefined);
    if (artifactKey) await minio.removeObject(config.MINIO_BUCKET, artifactKey).catch(() => undefined);
    await db.job.deleteMany({ where: { datasetId } });
    await db.asset.deleteMany({ where: { datasetId } });
    await db.dataset.delete({ where: { id: datasetId } });
    await db.user.delete({ where: { id: ownerId } });
    await db.$disconnect();
  });

  const { result } = await claimAndRun(db, successorJob.id);
  assert.equal(result, "completed");
  const textAsset = await db.textAsset.findUnique({ where: { assetId: asset.id } });
  assert.ok(textAsset?.sourceIdentity);
  artifactKey = textAsset?.boundaryArtifactKey ?? undefined;

  const successor = await db.job.findUnique({ where: { id: successorJob.id }, select: { retryOfJobId: true, status: true } });
  assert.equal(successor?.retryOfJobId, failedJob.id);
  assert.equal(successor?.status, "COMPLETED");
});
