import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { cleanupUnreferencedMediaDerivative } from "../../src/media/minio-compensation.js";
import { materializePrivateSource } from "../../src/media/source-materialization.js";

test("materializes only a verified private source within its configured bound", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fieldframe-media-source-test-"));
  try {
    const result = await materializePrivateSource({
      minio: {
        statObject: async () => ({ size: 4 }),
        getObject: async () => Readable.from([Buffer.from("data")]),
      },
      bucket: "private",
      objectKey: "repository-imports/dataset/object",
      destinationPath: join(directory, "source.bin"),
      expectedSizeBytes: BigInt(4),
      maxSourceBytes: BigInt(8),
    });
    assert.equal(result.kind, "materialized");
    if (result.kind === "materialized") assert.equal((await readFile(result.path)).toString(), "data");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses a mismatched private source before it is downloaded", async () => {
  let downloaded = false;
  const result = await materializePrivateSource({
    minio: {
      statObject: async () => ({ size: 5 }),
      getObject: async () => { downloaded = true; return Readable.from([]); },
    },
    bucket: "private",
    objectKey: "repository-imports/dataset/object",
    destinationPath: join(tmpdir(), "not-created"),
    expectedSizeBytes: BigInt(4),
    maxSourceBytes: BigInt(8),
  });
  assert.equal(result.kind, "policy_rejected");
  assert.equal(downloaded, false);
});

test("media compensation rejects outside scope before querying storage", async () => {
  let removed = false;
  const db = {
    asset: { findFirst: async () => null },
    assetVersion: { findFirst: async () => null },
    audioAsset: { findFirst: async () => null },
  } as never;
  const result = await cleanupUnreferencedMediaDerivative(db, { removeObject: async () => { removed = true; } }, {
    bucket: "private", objectKey: "repository-imports/dataset/object", assetId: "asset-1",
  });
  assert.equal(result, "outside_scope");
  assert.equal(removed, false);
});
