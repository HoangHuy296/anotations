import "../../../../scripts/db-safety/test-entry.cjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Client as MinioClient } from "minio";
import { db } from "@/lib/db";
import { assetIdOf, objectBytes, objectKey } from "./maintenance-fixture";

/**
 * Storage-side steps of the maintenance rehearsal, driven by `maintenance-step.json` in the receipt's private stage directory:
 *   mutate     — mn-m gets a different size, mn-n the SAME size with different bytes (new ETag), mn-o is deleted
 *   restore-m / restore-n / restore-o — the original bytes are put back
 * These change object metadata between approval and execution; they never touch PostgreSQL rows.
 */
const receipt = JSON.parse(readFileSync(process.env.DB_SAFETY_RECEIPT!, "utf8"));
const step = JSON.parse(readFileSync(join(dirname(receipt.config), "maintenance-step.json"), "utf8")) as { action: string };

test(`object step: ${step.action}`, async () => {
  const endpoint = new URL(process.env.MINIO_ENDPOINT!);
  const bucket = process.env.MINIO_BUCKET!;
  const store = new MinioClient({ endPoint: endpoint.hostname, port: Number(endpoint.port), useSSL: false, accessKey: process.env.MINIO_ACCESS_KEY!, secretKey: process.env.MINIO_SECRET_KEY!, region: "us-east-1" });
  const assetM = assetIdOf("mn-m-mutate-size", 1), assetN = assetIdOf("mn-n-mutate-etag", 1), assetO = assetIdOf("mn-o-mutate-missing", 1);
  const recorded = async (id: string) => Number((await db.asset.findUniqueOrThrow({ where: { id }, select: { sizeBytes: true } })).sizeBytes);
  try {
    if (step.action === "mutate") {
      await store.putObject(bucket, objectKey(assetM), objectBytes(assetM, (await recorded(assetM)) + 7));
      const before = await store.statObject(bucket, objectKey(assetN));
      await store.putObject(bucket, objectKey(assetN), objectBytes(assetN, await recorded(assetN), "other"));
      const after = await store.statObject(bucket, objectKey(assetN));
      assert.equal(after.size, before.size); assert.notEqual(after.etag, before.etag, "same size, different ETag");
      await store.removeObject(bucket, objectKey(assetO));
    } else if (step.action === "restore-m") await store.putObject(bucket, objectKey(assetM), objectBytes(assetM, await recorded(assetM)));
    else if (step.action === "restore-n") await store.putObject(bucket, objectKey(assetN), objectBytes(assetN, await recorded(assetN)));
    else if (step.action === "restore-o") await store.putObject(bucket, objectKey(assetO), objectBytes(assetO, await recorded(assetO)));
    else throw new Error("unknown step");
  } finally { await db.$disconnect(); }
});
