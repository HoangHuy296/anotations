import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test, { after, before } from "node:test";

import { Modality, StorageProvider, UserRole } from "@internal/db";

import { db } from "@/lib/db";
import { getDirectUploadProviders } from "@/lib/providers";
import { cleanupAnnotationFixture, createAnnotationDataset, createAnnotationUser } from "../annotation-api/helpers";

const enabled = process.env.VIDEO_VIEW_INTEGRATION_TESTS === "1";
const baseUrl = process.env.VIDEO_ANNOTATION_HTTP_BASE_URL ?? "http://127.0.0.1:3000";
const password = "workspace-test-password";
const suffix = randomBytes(6).toString("hex");
let owner: { id: string; email: string };
let outsider: { id: string; email: string };
let datasetId = "";
let assetId = "";
let objectKey = "";
let ownerCookie = "";
let outsiderCookie = "";

if (enabled) {
  // Test-runner topology only; the Compose web service keeps its internal
  // verification endpoint while emitted browser capability URLs stay public.
  process.env.MINIO_ENDPOINT = "http://localhost:9000";
  process.env.MINIO_PUBLIC_ENDPOINT = "http://localhost:9000";
}

function cookie(response: Response) {
  const token = /^fieldframe_session=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(token);
  return `fieldframe_session=${token}`;
}
async function login(email: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  assert.equal(response.status, 200);
  return cookie(response);
}

before(async () => {
  if (!enabled) return;
  owner = await createAnnotationUser(UserRole.MANAGER);
  outsider = await createAnnotationUser(UserRole.MANAGER);
  const dataset = await createAnnotationDataset(owner.id);
  datasetId = dataset.id;
  const { config, minio } = getDirectUploadProviders();
  objectKey = `phase019-video-view/${datasetId}/${suffix}.mp4`;
  const bytes = Buffer.from("phase019-private-video-bytes");
  await minio.putObject(config.MINIO_BUCKET, objectKey, bytes, bytes.length, { "content-type": "video/mp4" });
  const asset = await db.asset.create({ data: { datasetId, uploadedById: owner.id, modality: Modality.VIDEO, filename: "private.mp4", mimeType: "video/mp4", sizeBytes: BigInt(bytes.length), durationMs: 1000, storageProvider: StorageProvider.MINIO, storageBucket: config.MINIO_BUCKET, storageKey: objectKey, sourceFingerprint: `view-${suffix}` }, select: { id: true } });
  assetId = asset.id;
  await db.videoAsset.create({ data: { assetId } });
  ownerCookie = await login(owner.email);
  outsiderCookie = await login(outsider.email);
});

after(async () => {
  if (!enabled) return;
  const { config, minio } = getDirectUploadProviders();
  await minio.removeObject(config.MINIO_BUCKET, objectKey).catch(() => undefined);
  await cleanupAnnotationFixture([owner.id, outsider.id], [datasetId]);
});

test("private VIDEO capability is object-scoped, browser-direct, and foreign access is concealed", { skip: enabled ? false : "Set VIDEO_VIEW_INTEGRATION_TESTS=1 with Compose MinIO/web." }, async () => {
  const response = await fetch(`${baseUrl}/api/assets/${assetId}/view-url`, { headers: { Cookie: ownerCookie } });
  assert.equal(response.status, 200);
  const body = await response.json() as { data: { viewUrl: string; expiresAt: string; storageKey?: string; storageBucket?: string } };
  assert.ok(["localhost:9000", "127.0.0.1:9000"].includes(new URL(body.data.viewUrl).host));
  assert.equal(body.data.viewUrl.includes("minio:9000"), false);
  assert.equal("storageKey" in body.data, false);
  assert.equal("storageBucket" in body.data, false);
  assert.ok(Number.isFinite(Date.parse(body.data.expiresAt)));
  const binary = await fetch(body.data.viewUrl);
  assert.equal(binary.status, 200);
  assert.deepEqual(Buffer.from(await binary.arrayBuffer()), Buffer.from("phase019-private-video-bytes"));
  const denied = await fetch(`${baseUrl}/api/assets/${assetId}/view-url`, { headers: { Cookie: outsiderCookie } });
  assert.equal(denied.status, 404);
  const deniedText = JSON.stringify(await denied.json()).toLowerCase();
  for (const forbidden of ["storagekey", "storagebucket", "minio", "token", "stack", "database_url"]) assert.equal(deniedText.includes(forbidden), false);
});

test("VideoEngine uses the authorized capability rather than a Next.js binary proxy", async () => {
  const source = await readFile(path.resolve(process.cwd(), "src/components/workspace/video-engine.tsx"), "utf8");
  assert.match(source, /\/api\/assets\/\$\{encodeURIComponent\(video\.id\)\}\/view-url/);
  assert.match(source, /<video[^>]+src=\{viewUrl\}/);
  assert.equal(source.includes("/api/videos/"), false);
  assert.equal(source.includes("arrayBuffer()"), false);
});
