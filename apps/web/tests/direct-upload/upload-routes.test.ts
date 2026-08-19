import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import test, { after, before } from "node:test";

import { AssetStatus, DatasetSourceMode, Modality, StorageProvider } from "@internal/db";

import { db } from "@/lib/db";
import { getDirectUploadProviders } from "@/lib/providers";
import { verifyUploadCapability } from "@/lib/upload-capability";
import { verifyUploadedObject } from "@/lib/upload-verification";
import { MAX_DIRECT_UPLOAD_BYTES } from "@/lib/validation/upload";
import { addReadOnlyMember, configureDirectUploadTestEnvironment, createDirectUploadActors, fixtureBytes, hasIntegrationDatabase } from "./helpers";

const port = 3_115;
const baseUrl = `http://127.0.0.1:${port}`;
const password = "phase-six-http-password";
const suffix = `${Date.now()}-${randomBytes(5).toString("hex")}`;
let server: ChildProcess | undefined;
let managerEmail = "";
let outsiderEmail = "";
let managerCookie = "";
let outsiderCookie = "";
let datasetId = "";
let cleanupFixture: (() => Promise<void>) | undefined;

function cookie(response: Response) {
  const token = /^fieldframe_session=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(token, "login must issue an opaque session cookie");
  return `fieldframe_session=${token}`;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/api/auth/me`)).status === 401) return;
    } catch { /* server is starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Next.js upload test server did not start.");
}

async function login(email: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  assert.equal(response.status, 200);
  return cookie(response);
}

async function presign(contentType: "image/png" | "video/mp4" | "text/plain" | "audio/wav", filename: string, requestCookie = managerCookie) {
  const bytes = fixtureBytes(contentType);
  const response = await fetch(`${baseUrl}/api/assets/presigned-upload`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: requestCookie },
    body: JSON.stringify({ datasetId, filename, contentType, sizeBytes: bytes.length }),
  });
  return { response, bytes };
}

type PostUploadCapability = {
  uploadUrl: string;
  method: "POST";
  formFields: Record<string, string>;
  fileId: string;
  expiresInSeconds: number;
};

async function postUpload(capability: PostUploadCapability, bytes: Buffer, filename: string, fields = capability.formFields) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  form.append("file", new Blob([new Uint8Array(bytes)]), filename);
  return fetch(capability.uploadUrl, { method: capability.method, body: form });
}

async function uploadAndComplete(contentType: "image/png" | "video/mp4" | "text/plain" | "audio/wav", filename: string) {
  const { response, bytes } = await presign(contentType, filename);
  if (response.status !== 201) assert.fail(`Presign failed (${response.status}): ${await response.text()}`);
  const payload = await response.json() as { data: PostUploadCapability };
  assert.equal("storageKey" in payload.data, false);
  assert.equal("objectKey" in payload.data, false);
  assert.equal("bucket" in payload.data, false);
  assert.equal("MINIO_SECRET_KEY" in payload.data, false);
  assert.equal(payload.data.fileId.includes("direct-uploads"), false);
  assert.equal(payload.data.method, "POST");
  assert.ok(payload.data.formFields.key);
  assert.equal("MINIO_SECRET_KEY" in payload.data.formFields, false);
  const transfer = await postUpload(payload.data, bytes, filename);
  assert.ok(transfer.ok, `presigned POST failed: ${transfer.status}`);
  const completionStartedAt = performance.now();
  const completion = await fetch(`${baseUrl}/api/assets/complete-upload`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: managerCookie }, body: JSON.stringify({ fileId: payload.data.fileId }) });
  return { completion, completionStartedAt, fileId: payload.data.fileId, bytes };
}

before(async () => {
  if (!hasIntegrationDatabase) return;
  configureDirectUploadTestEnvironment();
  const fixture = await createDirectUploadActors(password, suffix);
  managerEmail = fixture.manager.email;
  outsiderEmail = fixture.outsider.email;
  datasetId = fixture.dataset.id;
  cleanupFixture = fixture.cleanup;
  server = spawn("node_modules/.bin/next", ["start", "--port", String(port)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MINIO_PUBLIC_ENDPOINT: "http://minio:9000",
      PRISMA_QUERY_ENGINE_LIBRARY: resolve(process.cwd(), "../../lib/generated/prisma/libquery_engine-debian-openssl-3.0.x.so.node"),
    },
    stdio: "ignore",
  });
  await waitForServer();
  managerCookie = await login(managerEmail);
  outsiderCookie = await login(outsiderEmail);
});

after(async () => {
  const running = server;
  if (running && running.exitCode === null) await new Promise<void>((resolve) => { running.once("exit", resolve); running.kill("SIGTERM"); });
  await cleanupFixture?.();
});

test("authorized image upload appears in the Dataset asset list within ten seconds and replays idempotently", { skip: !hasIntegrationDatabase }, async () => {
  const { completion, completionStartedAt, fileId } = await uploadAndComplete("image/png", "scene.png");
  if (completion.status !== 201) assert.fail(`Completion failed (${completion.status}): ${await completion.text()}`);
  const body = await completion.json() as { data: { asset: { id: string; modality: Modality; status: string; storageKey?: string }; replayed: boolean } };
  assert.equal(body.data.asset.modality, Modality.IMAGE);
  assert.equal(body.data.asset.status, "READY");
  assert.equal(body.data.replayed, false);
  assert.equal("storageKey" in body.data.asset, false);
  assert.ok(await db.imageAsset.findUnique({ where: { assetId: body.data.asset.id } }));
  assert.equal(await db.videoAsset.count({ where: { assetId: body.data.asset.id } }), 0);
  const assetList = await fetch(`${baseUrl}/api/datasets/${datasetId}/assets?limit=25`, { headers: { Cookie: managerCookie } });
  assert.equal(assetList.status, 200);
  const items = (await assetList.json() as { data: { items: Array<{ id: string; status: string; modality: Modality }> } }).data.items;
  assert.ok(items.some((item) => item.id === body.data.asset.id && item.status === "READY" && item.modality === Modality.IMAGE));
  assert.ok(performance.now() - completionStartedAt <= 10_000, "published asset must appear in the Dataset list within ten seconds");
  const replay = await fetch(`${baseUrl}/api/assets/complete-upload`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: managerCookie }, body: JSON.stringify({ fileId }) });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json() as { data: { replayed: boolean } }).data.replayed, true);
  const [iv, ciphertext, tag] = fileId.split(".");
  const replacement = ciphertext[0] === "A" ? "B" : "A";
  const tamperedToken = `${iv}.${replacement}${ciphertext.slice(1)}.${tag}`;
  const tampered = await fetch(`${baseUrl}/api/assets/complete-upload`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: managerCookie }, body: JSON.stringify({ fileId: tamperedToken }) });
  assert.equal(tampered.status, 400);
  assert.equal(await db.asset.count({ where: { datasetId, modality: Modality.IMAGE } }), 1);
});

test("all initial modalities publish exactly one matching child row without text body persistence", { skip: !hasIntegrationDatabase }, async () => {
  const cases = [
    ["video/mp4", "clip.mp4", Modality.VIDEO, "videoAsset"],
    ["text/plain", "notes.txt", Modality.TEXT, "textAsset"],
    ["audio/wav", "sound.wav", Modality.AUDIO, "audioAsset"],
  ] as const;
  for (const [contentType, filename, modality, relation] of cases) {
    const { completion } = await uploadAndComplete(contentType, filename);
    if (completion.status !== 201) assert.fail(`Completion failed (${completion.status}): ${await completion.text()}`);
    const assetId = (await completion.json() as { data: { asset: { id: string; modality: Modality } } }).data.asset.id;
    const asset = await db.asset.findUnique({ where: { id: assetId }, include: { imageAsset: true, videoAsset: true, textAsset: true, audioAsset: true } });
    assert.equal(asset?.modality, modality);
    assert.ok(asset?.[relation]);
    if (modality === Modality.TEXT) assert.equal(asset?.textAsset?.content, null);
  }
});

test("denied users have no upload side effect and authorized viewing remains dataset-scoped", { skip: !hasIntegrationDatabase }, async () => {
  const before = await db.asset.count({ where: { datasetId } });
  const denied = await presign("image/png", "hidden.png", outsiderCookie);
  assert.equal(denied.response.status, 404);
  assert.equal(await db.asset.count({ where: { datasetId } }), before);
  const { completion, bytes } = await uploadAndComplete("image/png", "view.png");
  if (completion.status !== 201) assert.fail(`Completion failed (${completion.status}): ${await completion.text()}`);
  const assetId = (await completion.json() as { data: { asset: { id: string } } }).data.asset.id;
  const view = await fetch(`${baseUrl}/api/assets/${assetId}/view-url`, { headers: { Cookie: managerCookie } });
  assert.equal(view.status, 200);
  const viewUrl = (await view.json() as { data: { viewUrl: string; storageKey?: string } }).data.viewUrl;
  assert.equal((await fetch(viewUrl)).status, 200);
  assert.deepEqual(Buffer.from(await (await fetch(viewUrl)).arrayBuffer()), bytes);
  const deniedView = await fetch(`${baseUrl}/api/assets/${assetId}/view-url`, { headers: { Cookie: outsiderCookie } });
  assert.equal(deniedView.status, 404);
  const outsider = await db.user.findUniqueOrThrow({ where: { email: outsiderEmail } });
  await addReadOnlyMember(datasetId, outsider.id);
  const readOnly = await presign("image/png", "readonly.png", outsiderCookie);
  assert.equal(readOnly.response.status, 403);
});

test("mismatched media is rejected with no published asset", { skip: !hasIntegrationDatabase }, async () => {
  const before = await db.asset.count({ where: { datasetId } });
  const { response } = await presign("image/png", "not-an-image.png");
  assert.equal(response.status, 201);
  const payload = await response.json() as { data: PostUploadCapability };
  const transfer = await postUpload(payload.data, Buffer.alloc(fixtureBytes("image/png").length, 0x61), "not-an-image.png");
  assert.ok(transfer.ok);
  const completion = await fetch(`${baseUrl}/api/assets/complete-upload`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: managerCookie }, body: JSON.stringify({ fileId: payload.data.fileId }) });
  assert.equal(completion.status, 415);
  assert.equal(await db.asset.count({ where: { datasetId } }), before);
});

test("MinIO POST policy rejects a wrong content type and an oversize object before completion", { skip: !hasIntegrationDatabase }, async () => {
  const wrongType = await presign("image/png", "wrong-type.png");
  assert.equal(wrongType.response.status, 201);
  const wrongTypeCapability = (await wrongType.response.json() as { data: PostUploadCapability }).data;
  const wrongFields = { ...wrongTypeCapability.formFields, "Content-Type": "text/plain" };
  const rejectedType = await postUpload(wrongTypeCapability, wrongType.bytes, "wrong-type.png", wrongFields);
  assert.ok(!rejectedType.ok, `MinIO accepted a form with a modified content type (${rejectedType.status})`);

  const oversized = await presign("image/png", "oversized.png");
  assert.equal(oversized.response.status, 201);
  const oversizedCapability = (await oversized.response.json() as { data: PostUploadCapability }).data;
  const oversizedBytes = Buffer.alloc(MAX_DIRECT_UPLOAD_BYTES + 1, 0x61);
  const rejectedSize = await postUpload(oversizedCapability, oversizedBytes, "oversized.png");
  assert.ok(!rejectedSize.ok, `MinIO accepted an object above ${MAX_DIRECT_UPLOAD_BYTES} bytes (${rejectedSize.status})`);
  assert.equal(await db.asset.count({ where: { datasetId, filename: { in: ["wrong-type.png", "oversized.png"] } } }), 0);
});

test("MinIO CORS permits POST only for the configured browser origin", { skip: !hasIntegrationDatabase }, async () => {
  const response = await fetch("http://minio:9000/", {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:3000",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:3000");
  assert.match(response.headers.get("access-control-allow-methods") ?? "", /POST/i);
});

test("publication failure cleans up an orphan object while a published replay retains its object", { skip: !hasIntegrationDatabase }, async () => {
  const { response, bytes } = await presign("image/png", "publication-conflict.png");
  assert.equal(response.status, 201);
  const capability = (await response.json() as { data: PostUploadCapability }).data;
  const transfer = await postUpload(capability, bytes, "publication-conflict.png");
  assert.ok(transfer.ok);

  const { config, minio } = getDirectUploadProviders();
  const internalCapability = verifyUploadCapability(config, capability.fileId);
  assert.ok(internalCapability);
  const verified = await verifyUploadedObject(minio, config.MINIO_BUCKET, internalCapability.objectKey, bytes.length, "image/png");
  const conflicting = await db.asset.create({
    data: {
      datasetId,
      uploadedById: (await db.user.findUniqueOrThrow({ where: { email: managerEmail } })).id,
      modality: Modality.IMAGE,
      filename: "existing-conflict.png",
      mimeType: "image/png",
      sizeBytes: verified.sizeBytes,
      sourceMode: DatasetSourceMode.UPLOAD,
      storageProvider: StorageProvider.MINIO,
      storageBucket: config.MINIO_BUCKET,
      storageKey: `test-conflicts/${suffix}/existing-conflict.png`,
      sourceFingerprint: verified.sourceFingerprint,
      status: AssetStatus.READY,
      imageAsset: { create: { exif: {} } },
    },
  });
  try {
    const rejectedClientStorageFields = await fetch(`${baseUrl}/api/assets/complete-upload`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: managerCookie }, body: JSON.stringify({ fileId: capability.fileId, objectKey: internalCapability.objectKey, bucket: config.MINIO_BUCKET }) });
    assert.equal(rejectedClientStorageFields.status, 400);
    const completion = await fetch(`${baseUrl}/api/assets/complete-upload`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: managerCookie }, body: JSON.stringify({ fileId: capability.fileId }) });
    assert.equal(completion.status, 409);
    assert.equal(await db.asset.count({ where: { storageBucket: config.MINIO_BUCKET, storageKey: internalCapability.objectKey } }), 0);
    await assert.rejects(minio.statObject(config.MINIO_BUCKET, internalCapability.objectKey));
  } finally {
    await db.asset.delete({ where: { id: conflicting.id } });
  }

  const published = await uploadAndComplete("image/png", "published-replay.png");
  assert.equal(published.completion.status, 201);
  const replay = await fetch(`${baseUrl}/api/assets/complete-upload`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: managerCookie }, body: JSON.stringify({ fileId: published.fileId }) });
  assert.equal(replay.status, 200);
  const publishedAsset = (await published.completion.json() as { data: { asset: { id: string } } }).data.asset;
  const object = await db.asset.findUniqueOrThrow({ where: { id: publishedAsset.id }, select: { storageBucket: true, storageKey: true } });
  assert.ok(object.storageBucket && object.storageKey);
  await minio.statObject(object.storageBucket, object.storageKey);
});
