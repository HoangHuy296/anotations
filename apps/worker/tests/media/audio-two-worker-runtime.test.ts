import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createQueueTransport } from "@fieldframe/queue";
import { createWorkerDatabase } from "../../src/providers/db.js";
import { getWorkerConfig } from "../../src/config.js";
import { createWorkerMinio } from "../../src/providers/minio.js";

const enabled = process.env.MEDIA_TWO_WORKER_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

function tinyWav() {
  const samples = Buffer.alloc(4_000);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + samples.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8_000, 24); header.writeUInt32LE(16_000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(samples.length, 40); return Buffer.concat([header, samples]);
}

test("two real workers converge duplicate AUDIO deliveries to one result", { skip: enabled ? false : "requires MEDIA_TWO_WORKER_INTEGRATION_TESTS=1 and two Compose workers" }, async () => {
  const config = getWorkerConfig(); const db = createWorkerDatabase(config);
  const queue = createQueueTransport({ host: config.REDIS_HOST, port: config.REDIS_PORT, password: config.REDIS_PASSWORD, db: config.REDIS_DB, prefix: config.BULLMQ_PREFIX });
  const minio = createWorkerMinio(config); const suffix = randomUUID(); const sourceKey = `phase018-test/audio-two/${suffix}.wav`;
  let datasetId: string | null = null;
  try {
    const owner = await db.user.create({ data: { email: `phase018-two-${suffix}@test.invalid`, role: "MANAGER" }, select: { id: true } });
    const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `phase018-two-${suffix}` }, select: { id: true } }); datasetId = dataset.id;
    const source = tinyWav(); await minio.putObject(config.MINIO_BUCKET, sourceKey, source, source.length, { "Content-Type": "audio/wav" });
    const fingerprint = `phase018-two-${suffix}`;
    const asset = await db.asset.create({ data: { datasetId, modality: "AUDIO", filename: "two.wav", mimeType: "audio/wav", sourceFingerprint: fingerprint, storageProvider: "MINIO", storageBucket: config.MINIO_BUCKET, storageKey: sourceKey, sizeBytes: BigInt(source.length), checksum: "two-checksum" }, select: { id: true } });
    const job = await db.job.create({ data: { datasetId, createdById: owner.id, type: "GENERATE_AUDIO_WAVEFORM", modality: "AUDIO", status: "QUEUED", totalItems: 1, input: { assetId: asset.id, processorVersion: "fieldframe.media.v1", source: { sourceFingerprint: fingerprint, checksum: "two-checksum", sizeBytes: String(source.length), sourceRevision: null } } }, select: { id: true } });
    await Promise.all([queue.add("delivery-a", { jobId: job.id }), queue.add("delivery-b", { jobId: job.id })]);
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const current = await db.job.findUniqueOrThrow({ where: { id: job.id }, select: { status: true } });
      if (["COMPLETED", "FAILED", "CANCELED"].includes(current.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const final = await db.job.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, errorCode: true } });
    assert.equal(final.status, "COMPLETED", `safe error code: ${final.errorCode ?? "none"}`);
    assert.equal(await db.audioAsset.count({ where: { assetId: asset.id } }), 1);
    assert.equal(await db.jobEvent.count({ where: { jobId: job.id, message: "JOB_COMPLETED" } }), 1);
  } finally {
    if (datasetId) await db.dataset.delete({ where: { id: datasetId } }).catch(() => undefined);
    await minio.removeObject(config.MINIO_BUCKET, sourceKey).catch(() => undefined);
    await queue.close(); await db.$disconnect();
  }
});
