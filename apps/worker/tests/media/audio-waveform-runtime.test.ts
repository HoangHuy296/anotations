import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createQueueTransport } from "@annotationplatform/queue";
import { createWorkerDatabase } from "../../src/providers/db.js";
import { getWorkerConfig } from "../../src/config.js";
import { createWorkerMinio } from "../../src/providers/minio.js";

const enabled = process.env.MEDIA_RUNTIME_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

function tinyWav() {
  const sampleRate = 8_000;
  const samples = Buffer.alloc(sampleRate / 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + samples.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

async function waitForTerminal(db: ReturnType<typeof createWorkerDatabase>, id: string) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const job = await db.job.findUniqueOrThrow({ where: { id }, select: { status: true, errorCode: true } });
    if (["COMPLETED", "FAILED", "CANCELED"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("audio media job did not reach terminal state");
}

test("private AUDIO job produces one safe derivative and AudioAsset in Compose", { skip: enabled ? false : "requires MEDIA_RUNTIME_INTEGRATION_TESTS=1 and controlled Compose" }, async () => {
  const config = getWorkerConfig();
  const db = createWorkerDatabase(config);
  const queue = createQueueTransport({ host: config.REDIS_HOST, port: config.REDIS_PORT, password: config.REDIS_PASSWORD, db: config.REDIS_DB, prefix: config.BULLMQ_PREFIX });
  const minio = createWorkerMinio(config);
  const suffix = randomUUID();
  const sourceKey = `phase018-test/audio/${suffix}.wav`;
  let datasetId: string | null = null;
  try {
    const owner = await db.user.create({ data: { email: `phase018-audio-${suffix}@test.invalid`, role: "MANAGER" }, select: { id: true } });
    const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `phase018-audio-${suffix}` }, select: { id: true } });
    datasetId = dataset.id;
    const source = tinyWav();
    await minio.putObject(config.MINIO_BUCKET, sourceKey, source, source.length, { "Content-Type": "audio/wav" });
    const fingerprint = `phase018-audio-${suffix}`;
    const asset = await db.asset.create({ data: { datasetId, modality: "AUDIO", filename: "fixture.wav", mimeType: "audio/wav", sourceFingerprint: fingerprint, storageProvider: "MINIO", storageBucket: config.MINIO_BUCKET, storageKey: sourceKey, sizeBytes: BigInt(source.length), checksum: "fixture-checksum" }, select: { id: true } });
    const job = await db.job.create({ data: { datasetId, createdById: owner.id, type: "GENERATE_AUDIO_WAVEFORM", modality: "AUDIO", status: "QUEUED", totalItems: 1, idempotencyKey: `phase018-audio-${fingerprint}`, input: { assetId: asset.id, processorVersion: "fieldframe.media.v1", source: { sourceFingerprint: fingerprint, checksum: "fixture-checksum", sizeBytes: String(source.length), sourceRevision: null } } }, select: { id: true } });
    await queue.add("durable-job", { jobId: job.id }, { jobId: job.id });
    assert.deepEqual((await queue.getJob(job.id))?.data, { jobId: job.id });
    const terminal = await waitForTerminal(db, job.id);
    assert.equal(terminal.status, "COMPLETED", `safe error code: ${terminal.errorCode ?? "none"}`);
    const stored = await db.audioAsset.findUniqueOrThrow({ where: { assetId: asset.id }, select: { waveformKey: true, sampleRate: true, channels: true } });
    assert.ok(stored.waveformKey?.startsWith(`audio-waveforms/${datasetId}/${asset.id}/`));
    await minio.statObject(config.MINIO_BUCKET, stored.waveformKey!);
    assert.equal(await db.audioAsset.count({ where: { assetId: asset.id } }), 1);
    assert.equal(await db.jobEvent.count({ where: { jobId: job.id, message: "JOB_COMPLETED" } }), 1);
    assert.equal(JSON.stringify(await db.jobEvent.findMany({ where: { jobId: job.id }, select: { data: true, message: true } })).includes("ffmpeg"), false);
  } finally {
    if (datasetId) {
      const assets = await db.asset.findMany({ where: { datasetId }, select: { storageKey: true } }).catch(() => []);
      await db.dataset.delete({ where: { id: datasetId } }).catch(() => undefined);
      await Promise.all(assets.map((asset) => asset.storageKey ? minio.removeObject(config.MINIO_BUCKET, asset.storageKey).catch(() => undefined) : undefined));
    }
    await minio.removeObject(config.MINIO_BUCKET, sourceKey).catch(() => undefined);
    await queue.close();
    await db.$disconnect();
  }
});
