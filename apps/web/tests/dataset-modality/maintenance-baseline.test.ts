import "../../../../scripts/db-safety/test-entry.cjs";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client as MinioClient } from "minio";
import { db } from "@/lib/db";
import { DATASETS, assetIdOf, objectBytes, objectKey } from "./maintenance-fixture";

/**
 * Seed for `release:phase029-backfill-maintenance`: REAL objects in the receipt-owned disposable MinIO, then historical-style unresolved rows on the
 * 23-migration baseline (baseline client from `g2:generate`). Object sizes and ETags in the rows come from the objects actually stored.
 */
const receipt = JSON.parse(readFileSync(process.env.DB_SAFETY_RECEIPT!, "utf8"));
const MODALITY_MIME = { IMAGE: "image/png", VIDEO: "video/mp4", AUDIO: "audio/wav", TEXT: "text/plain" } as const;
const CHILD: Record<string, object> = { IMAGE: { imageAsset: { create: { exif: {} } } }, VIDEO: { videoAsset: { create: { metadata: {} } } }, AUDIO: { audioAsset: { create: { metadata: {} } } }, TEXT: { textAsset: { create: { tokenization: {}, metadata: {} } } } };

test("real objects are stored and historical unresolved datasets are seeded on the 23-migration baseline", async () => {
  const endpoint = new URL(process.env.MINIO_ENDPOINT!);
  const bucket = process.env.MINIO_BUCKET!;
  const store = new MinioClient({ endPoint: endpoint.hostname, port: Number(endpoint.port), useSSL: false, accessKey: process.env.MINIO_ACCESS_KEY!, secretKey: process.env.MINIO_SECRET_KEY!, region: "us-east-1" });
  for (const name of [bucket, `${bucket}-other`]) if (!(await store.bucketExists(name))) await store.makeBucket(name, "us-east-1");
  const { PrismaClient } = await import(pathToFileURL(join(dirname(receipt.config), "baseline-client/client.ts")).href);
  const baseline = new PrismaClient();
  try {
    await baseline.user.create({ data: { id: "mn-owner", email: "mn-owner@test.invalid", role: "MANAGER" }, select: { id: true } });
    for (const spec of DATASETS) {
      await baseline.dataset.create({ data: { id: spec.id, name: spec.id, ownerId: "mn-owner", metadata: { workflowStatus: "COMPLETED" }, ...(spec.primary ? { primaryModality: spec.primary } : {}) }, select: { id: true } });
      let index = 0;
      for (const asset of spec.assets ?? []) {
        index += 1;
        const id = assetIdOf(spec.id, index);
        const modality = asset.modality ?? "IMAGE";
        const size = asset.size ?? 10 + index;
        let etag: string | undefined;
        if (asset.upload !== false) {
          const put = await store.putObject(bucket, objectKey(id), objectBytes(id, size));
          etag = put.etag;
        }
        const recordedSize = asset.recordedSize === undefined ? size : asset.recordedSize;
        await baseline.asset.create({ data: {
          id, datasetId: spec.id, filename: `${id}.bin`, relativePath: `${id}.bin`, sourceFingerprint: `mn-fixture:${id}`, modality, mimeType: MODALITY_MIME[modality],
          storageProvider: "MINIO", storageBucket: asset.bucket === "foreign" ? `${bucket}-other` : bucket, storageKey: objectKey(id),
          ...(recordedSize === null ? {} : { sizeBytes: BigInt(recordedSize) }),
          ...(asset.etag ? { sourceEtag: asset.etag === "real" ? etag : "00000000000000000000000000000000" } : {}),
          ...CHILD[modality],
        }, select: { id: true } });
      }
    }
  } finally { await baseline.$disconnect(); await db.$disconnect(); }
});
