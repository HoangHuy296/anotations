import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify the disposable target before any fixture is created.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { MEDIA_VERIFICATION_ALLOWANCE_MS, buildSealedKey, validateMediaVerificationRow, type MediaVerificationRowFacts } from "@annotationplatform/domain/media-verification";

import type { Client as MinioClient } from "minio";

import { getWorkerConfig } from "../../src/config.js";
import { createWorkerDatabase } from "../../src/providers/db.js";
import { createWorkerMinio, ensureBucket } from "../../src/providers/minio.js";
import { withJobTempWorkspace } from "../../src/media/temp-workspace.js";
import type { ProbeRun, VerifierDeps } from "../../src/verification/types.js";

export type Corpus = { fixtures: Array<{ file: string; sha256: string; bytes: number; ffprobeExit: number; document: unknown }> };
export const corpus: Corpus = JSON.parse(readFileSync(new URL("../media/fixtures/premedia-corpus.json", import.meta.url), "utf8"));
export const corpusDocument = (file: string) => { const found = corpus.fixtures.find((fixture) => fixture.file === file); if (!found?.document) throw new Error(`corpus fixture ${file} has no document`); return found.document; };

export const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export async function createHarness() {
  const config = getWorkerConfig();
  const db = createWorkerDatabase(config);
  const minio = createWorkerMinio(config);
  await ensureBucket(minio, config.MINIO_BUCKET, { legacyAdmin: true }); // disposable root MinIO only
  const suffix = randomUUID().slice(0, 8);
  const owner = await db.user.create({ data: { email: `a2-${suffix}@test.invalid`, role: "MANAGER" }, select: { id: true } });
  const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `a2-${suffix}`, modality: "VIDEO", primaryModality: "VIDEO", modalityResolverSubject: owner.id }, select: { id: true } });
  const keys = new Set<string>();

  const stage = async (bytes: Buffer, name = "clip.mp4") => {
    const key = `direct-uploads/${dataset.id}/${owner.id}/${randomUUID()}/${name}`;
    await minio.putObject(config.MINIO_BUCKET, key, bytes, bytes.length);
    keys.add(key);
    const stat = await minio.statObject(config.MINIO_BUCKET, key);
    return { key, bytes, etag: stat.etag, lastModified: stat.lastModified, size: stat.size };
  };

  /** A PENDING verification + its Job already CLAIMED (RUNNING with a live lease), exactly what the router hands the processor. */
  const createVerification = async (staged: Awaited<ReturnType<typeof stage>>, options: { datasetId?: string; source?: "DIRECT_UPLOAD" | "LOCAL_FOLDER_ITEM"; preparedImportItemId?: string; relativePathHint?: string; filename?: string; deadlineAt?: Date; claim?: boolean } = {}) => {
    const id = randomUUID();
    const lockToken = randomUUID();
    const datasetId = options.datasetId ?? dataset.id;
    const job = await db.job.create({
      data: {
        datasetId, createdById: owner.id, type: "VERIFY_UPLOADED_MEDIA", modality: "VIDEO", status: options.claim === false ? "QUEUED" : "RUNNING", totalItems: 1,
        input: { verificationId: id, contractVersion: 1 }, ...(options.claim === false ? {} : { lockedBy: "test-worker", lockToken, lockedAt: new Date(), lockedUntil: new Date(Date.now() + 300_000), heartbeatAt: new Date(), startedAt: new Date() }),
      },
      select: { id: true },
    });
    const verification = await db.mediaVerification.create({
      data: {
        id, datasetId, requestedById: owner.id, source: options.source ?? "DIRECT_UPLOAD", preparedImportItemId: options.preparedImportItemId ?? null, currentJobId: job.id, boundDatasetModality: "VIDEO",
        stagedBucket: config.MINIO_BUCKET, stagedKey: staged.key, stagedEtag: staged.etag, stagedSizeBytes: BigInt(staged.size), stagedLastModified: staged.lastModified,
        filename: options.filename ?? "clip.mp4", relativePathHint: options.relativePathHint ?? null, declaredContentType: "video/mp4", declaredSizeBytes: BigInt(staged.size),
        verificationDeadlineAt: options.deadlineAt ?? new Date(Date.now() + MEDIA_VERIFICATION_ALLOWANCE_MS),
      },
    });
    return { verification, jobId: job.id, lockToken, sealedKey: buildSealedKey(datasetId, id) };
  };

  /** Re-claims a Job the way the router does after a retry/redelivery (RETRYING/QUEUED -> RUNNING with a fresh lease). */
  const reclaim = async (jobId: string) => {
    const lockToken = randomUUID();
    const row = await db.job.updateMany({ where: { id: jobId, status: { in: ["QUEUED", "RETRYING"] } }, data: { status: "RUNNING", lockedBy: "test-worker", lockToken, lockedAt: new Date(), lockedUntil: new Date(Date.now() + 300_000), heartbeatAt: new Date() } });
    if (row.count !== 1) throw new Error("RECLAIM_REFUSED");
    return lockToken;
  };

  const probeFor = (file: string): VerifierDeps["probe"] => async () => ({ kind: "COMPLETED", document: corpusDocument(file) });
  const deps = (overrides: Partial<VerifierDeps> = {}): VerifierDeps => ({
    minio: minio as VerifierDeps["minio"], bucket: config.MINIO_BUCKET, now: () => new Date(),
    probe: probeFor("mp4_h264_video_audio.mp4"),
    versions: async () => ({ ffprobeVersion: "5.1.9-0+deb12u1", processorVersion: "worker@test+ffprobe@5.1.9-0+deb12u1" }),
    assertWritesNotQuiesced: async () => undefined, withTempWorkspace: withJobTempWorkspace, sourceCapBytes: 100 * 1024 * 1024, probeTimeoutMs: 120_000,
    ...overrides,
  });

  const exists = async (key: string) => { try { await minio.statObject(config.MINIO_BUCKET, key); return true; } catch { return false; } };
  const assetCount = () => db.asset.count({ where: { datasetId: dataset.id } });
  const videoAssetCount = () => db.videoAsset.count({ where: { asset: { datasetId: dataset.id } } });
  const reload = (id: string) => db.mediaVerification.findUniqueOrThrow({ where: { id } });
  const jobOf = (id: string) => db.job.findUniqueOrThrow({ where: { id }, select: { status: true, errorCode: true, attempts: true, runAfter: true, errorDetails: true, finishedAt: true, enqueuedAt: true } });

  /** The frozen section-4 field/state table, asserted against the REAL persisted row. */
  const assertConsistent = async (id: string) => {
    const row = await reload(id);
    const result = validateMediaVerificationRow(row as unknown as MediaVerificationRowFacts);
    if (!result.ok) throw new Error(`MediaVerification ${row.status} violates the frozen field/state table: ${result.violations.join(",")}`);
    return row;
  };

  const cleanup = async () => {
    for (const row of await db.mediaVerification.findMany({ where: { datasetId: dataset.id }, select: { sealedKey: true } })) if (row.sealedKey) keys.add(row.sealedKey);
    for (const key of keys) await minio.removeObject(config.MINIO_BUCKET, key).catch(() => undefined);
    await db.dataset.deleteMany({ where: { ownerId: owner.id } });
    await db.user.deleteMany({ where: { id: owner.id } });
    await db.$disconnect();
  };
  return { config, db, minio: minio as MinioClient, owner, dataset, stage, createVerification, reclaim, deps, probeFor, exists, assetCount, videoAssetCount, reload, jobOf, assertConsistent, cleanup, trackKey: (key: string) => keys.add(key) };
}
export type Harness = Awaited<ReturnType<typeof createHarness>>;
export type { ProbeRun };
