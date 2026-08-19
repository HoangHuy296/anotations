import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";

import { AssetStatus, Modality, StorageProvider, UserRole } from "@internal/db";

import { hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { getDirectUploadProviders } from "@/lib/providers";
import { readWorkspacePage } from "@/lib/workspace/workspace-read";
import { cleanupWorkspaceFixture, createWorkspaceDataset, createWorkspaceUser, workspaceUnique } from "./helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && process.env.MINIO_VIEW_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const databaseEnabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);
// The Node runner is on the host, whereas the application container uses the
// Compose-only hostname. This stays process-local and never writes `.env`.
if (enabled) {
  process.env.MINIO_ENDPOINT = "http://localhost:9000";
  process.env.MINIO_PUBLIC_ENDPOINT = "http://localhost:9000";
}
const port = 3_117;
const baseUrl = `http://127.0.0.1:${port}`;
const password = "workspace-view-password";
let server: ChildProcess | undefined;
let managerEmail = "";
let outsiderEmail = "";
let managerCookie = "";
let outsiderCookie = "";
let assetId = "";
let objectKey = "";
let cleanup: (() => Promise<void>) | undefined;

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await fetch(`${baseUrl}/api/auth/me`)).status === 401) return; } catch { /* server starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Workspace image test server did not start.");
}

async function login(email: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  assert.equal(response.status, 200);
  const token = /^fieldframe_session=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(token);
  return `fieldframe_session=${token}`;
}

before(async () => {
  if (!enabled) return;
  const suffix = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const passwordHash = await hashPassword(password);
  const [manager, outsider] = await Promise.all([
    db.user.create({ data: { email: `workspace-view-manager-${suffix}@test.invalid`, passwordHash, role: UserRole.MANAGER }, select: { id: true, email: true } }),
    db.user.create({ data: { email: `workspace-view-outsider-${suffix}@test.invalid`, passwordHash, role: UserRole.LABELER }, select: { id: true, email: true } }),
  ]);
  managerEmail = manager.email; outsiderEmail = outsider.email;
  const dataset = await db.dataset.create({ data: { ownerId: manager.id, name: workspaceUnique("workspace-view-dataset") }, select: { id: true } });
  const { config, minio } = getDirectUploadProviders();
  objectKey = `workspace-view-tests/${dataset.id}/${suffix}.png`;
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  await minio.putObject(config.MINIO_BUCKET, objectKey, bytes, bytes.length, { "Content-Type": "image/png" });
  const asset = await db.asset.create({ data: { datasetId: dataset.id, uploadedById: manager.id, modality: Modality.IMAGE, filename: "view.png", mimeType: "image/png", sizeBytes: BigInt(bytes.length), storageProvider: StorageProvider.MINIO, storageBucket: config.MINIO_BUCKET, storageKey: objectKey, sourceFingerprint: workspaceUnique("workspace-view") }, select: { id: true } });
  assetId = asset.id;
  cleanup = async () => { await minio.removeObject(config.MINIO_BUCKET, objectKey).catch(() => undefined); await db.dataset.deleteMany({ where: { id: dataset.id } }); await db.user.deleteMany({ where: { id: { in: [manager.id, outsider.id] } } }); };
  server = spawn("node_modules/.bin/next", ["start", "--port", String(port)], { cwd: process.cwd(), env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" }, stdio: "ignore" });
  await waitForServer();
  managerCookie = await login(managerEmail);
  outsiderCookie = await login(outsiderEmail);
});

after(async () => {
  if (server && server.exitCode === null) await new Promise<void>((resolve) => { server?.once("exit", resolve); server?.kill("SIGTERM"); });
  await cleanup?.();
});

test("authorized image view capability reads MinIO while cross-Dataset access is concealed", { skip: !enabled }, async () => {
  const response = await fetch(`${baseUrl}/api/assets/${assetId}/view-url`, { headers: { Cookie: managerCookie } });
  assert.equal(response.status, 200);
  const body = await response.json() as { data: { viewUrl: string; expiresAt: string; storageKey?: string; storageBucket?: string } };
  assert.ok(body.data.viewUrl.startsWith("http://localhost:") || body.data.viewUrl.startsWith("https://"));
  assert.equal(body.data.viewUrl.includes("minio:9000"), false);
  assert.equal("storageKey" in body.data, false);
  assert.equal("storageBucket" in body.data, false);
  assert.ok(Number.isFinite(Date.parse(body.data.expiresAt)));
  const binary = await fetch(body.data.viewUrl);
  assert.equal(binary.status, 200);
  assert.deepEqual(Buffer.from(await binary.arrayBuffer()), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const denied = await fetch(`${baseUrl}/api/assets/${assetId}/view-url`, { headers: { Cookie: outsiderCookie } });
  assert.equal(denied.status, 404);
});

test("250-Asset search, multi-status filtering, stable order, and 10-item pages are Dataset-scoped", { skip: !databaseEnabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    await db.asset.createMany({ data: Array.from({ length: 250 }, (_, index) => ({
      datasetId: dataset.id, modality: Modality.IMAGE,
      filename: index === 249 ? "Needle-Outside-First-Page.png" : `image-${String(index).padStart(3, "0")}.png`,
      mimeType: "image/png", sourceFingerprint: workspaceUnique(`page-${index}`), batchIndex: Math.floor(index / 100),
      orderIndex: index, status: index % 2 ? AssetStatus.IN_PROGRESS : AssetStatus.NEW,
    })) });
    // FR-043 sets WORKSPACE_ASSET_PAGE_SIZE = 10: 250 assets is exactly 25
    // full pages of 10, so page 25 is the last populated page and page 26 is
    // the "beyond the last page" case -- empty items, real total, never an
    // error, per contracts/pagination-envelope.md.
    const [first, second, last, beyondLast, match, multiStatus] = await Promise.all([
      readWorkspacePage(owner, dataset.id, { page: 1 }),
      readWorkspacePage(owner, dataset.id, { page: 2 }),
      readWorkspacePage(owner, dataset.id, { page: 25 }),
      readWorkspacePage(owner, dataset.id, { page: 26 }),
      readWorkspacePage(owner, dataset.id, { page: 1, search: "needle-outside" }),
      readWorkspacePage(owner, dataset.id, { page: 1, statuses: [AssetStatus.NEW, AssetStatus.IN_PROGRESS] }),
    ]);
    assert.equal(first?.page.items.length, 10);
    assert.equal(second?.page.items.length, 10);
    assert.equal(last?.page.items.length, 10);
    assert.equal(beyondLast?.page.items.length, 0);
    assert.equal(beyondLast?.page.total, 250);
    assert.equal(first?.page.total, 250);
    assert.equal(first?.page.completed, 125);
    assert.notEqual(first?.page.items.at(-1)?.id, second?.page.items[0]?.id);
    assert.equal(match?.page.items[0]?.filename, "Needle-Outside-First-Page.png");
    assert.equal(multiStatus?.page.total, 250);
    assert.equal(multiStatus?.page.items[0]?.filename, "image-000.png");
    assert.equal(multiStatus?.page.items[1]?.filename, "image-001.png");
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});
