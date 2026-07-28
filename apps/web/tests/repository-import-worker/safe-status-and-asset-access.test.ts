import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import test, { after, before } from "node:test";

import { DatasetSourceMode, Modality, StorageProvider, UserRole } from "@internal/db";

import { hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { getDirectUploadProviders } from "@/lib/providers";

const enabled = process.env.REPOSITORY_ASSET_HTTP_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const port = 3_120;
const baseUrl = `http://127.0.0.1:${port}`;
const password = "phase016-http-password";
const suffix = `${Date.now()}-${randomBytes(5).toString("hex")}`;
let server: ChildProcess | undefined;
let datasetId = "";
let assetId = "";
let objectKey = "";
let managerEmail = "";
let outsiderEmail = "";
let memberEmail = "";
let jobId = "";
const stateJobIds = new Map<string, string>();
let otherDatasetId = "";

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await fetch(`${baseUrl}/api/auth/me`)).status === 401) return; } catch { /* wait for server */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Phase 016 web server did not start.");
}

async function login(email: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  assert.equal(response.status, 200);
  const value = /^fieldframe_session=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(value);
  return `fieldframe_session=${value}`;
}

before(async () => {
  if (!enabled) return;
  process.env.MINIO_ENDPOINT = "http://localhost:9000";
  process.env.MINIO_PUBLIC_ENDPOINT = "http://localhost:9000";
  const passwordHash = await hashPassword(password);
  const [manager, outsider, member] = await Promise.all([
    db.user.create({ data: { email: `phase016-manager-${suffix}@test.invalid`, passwordHash, role: UserRole.MANAGER }, select: { id: true, email: true } }),
    db.user.create({ data: { email: `phase016-outsider-${suffix}@test.invalid`, passwordHash, role: UserRole.LABELER }, select: { id: true, email: true } }),
    db.user.create({ data: { email: `phase016-member-${suffix}@test.invalid`, passwordHash, role: UserRole.REVIEWER }, select: { id: true, email: true } }),
  ]);
  managerEmail = manager.email;
  outsiderEmail = outsider.email;
  memberEmail = member.email;
  const dataset = await db.dataset.create({ data: { ownerId: manager.id, name: `phase016-http-${suffix}`, sourceMode: DatasetSourceMode.MIRROR_TO_MINIO }, select: { id: true } });
  datasetId = dataset.id;
  await db.datasetMember.create({ data: { datasetId: dataset.id, userId: member.id, role: "REVIEWER" } });
  const job = await db.job.create({ data: {
    datasetId: dataset.id, createdById: manager.id, type: "IMPORT_DATASET", status: "COMPLETED", stage: "FINISHED",
    progress: 100, totalItems: 3, processedItems: 3, successItems: 2, failedItems: 1, skippedItems: 0,
    input: { token: "phase016-secret", storageKey: "repository-imports/private" }, state: { providerRaw: "never-public" },
    summary: { outcome: "completed", imported: 2, skipped: 0, failed: 1 }, error: "raw sensitive diagnostic", errorCode: "SOURCE_PROVIDER_UNAVAILABLE", errorDetails: { token: "phase016-secret" }, startedAt: new Date(), finishedAt: new Date(),
  }, select: { id: true } });
  jobId = job.id;
  const stateJobs = await Promise.all([
    ["QUEUED", null],
    ["RUNNING", "UPLOADING_OBJECTS"],
    ["RETRYING", "SCANNING_FILES"],
    ["CANCELING", "WRITING_ASSETS"],
    ["CANCELED", "FINISHED"],
    ["FAILED", "SCANNING_FILES"],
  ].map(async ([status, stage]) => {
    const created = await db.job.create({ data: {
      datasetId: dataset.id, createdById: manager.id, type: "IMPORT_DATASET", status: status as "QUEUED" | "RUNNING" | "RETRYING" | "CANCELING" | "CANCELED" | "FAILED", ...(stage ? { stage: stage as never } : {}),
      progress: status === "QUEUED" ? 0 : 37, totalItems: 3, processedItems: 1, successItems: 1, failedItems: 0, skippedItems: 0,
      input: { token: "phase016-state-secret", storageKey: "repository-imports/private-state" }, state: { providerRaw: "never-public" },
      summary: { outcome: "completed", imported: 1, skipped: 0, failed: 0 }, error: "raw state diagnostic", errorCode: "SOURCE_PROVIDER_UNAVAILABLE",
      ...(status === "CANCELED" ? { canceledAt: new Date() } : {}),
    }, select: { id: true } });
    await db.jobEvent.create({ data: { jobId: created.id, message: "IMPORT_BATCH_COMPLETED", level: "INFO", stage: stage as never, data: { imported: 1, token: "phase016-state-secret", storageKey: "private-state" } } });
    return [status, created.id] as [string, string];
  }));
  for (const [status, id] of stateJobs) stateJobIds.set(status, id);
  const otherDataset = await db.dataset.create({ data: { ownerId: manager.id, name: `phase016-other-${suffix}`, sourceMode: DatasetSourceMode.MIRROR_TO_MINIO }, select: { id: true } });
  otherDatasetId = otherDataset.id;
  await db.jobEvent.create({ data: { jobId, message: "IMPORT_BATCH_COMPLETED", level: "INFO", data: { imported: 2, token: "phase016-secret", storageKey: "private" } } });
  const { config, minio } = getDirectUploadProviders();
  objectKey = `repository-imports/${dataset.id}/phase016-http-${suffix}`;
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  await minio.putObject(config.MINIO_BUCKET, objectKey, bytes, bytes.length, { "Content-Type": "image/png" });
  const asset = await db.asset.create({ data: { datasetId: dataset.id, uploadedById: manager.id, modality: Modality.IMAGE, filename: "mirrored.png", mimeType: "image/png", sizeBytes: BigInt(bytes.length), sourceMode: DatasetSourceMode.MIRROR_TO_MINIO, storageProvider: StorageProvider.MINIO, storageBucket: config.MINIO_BUCKET, storageKey: objectKey, sourceProvider: "GITEA", sourceRef: "main", sourceFingerprint: `phase016-http-${suffix}`, imageAsset: { create: {} } }, select: { id: true } });
  assetId = asset.id;
  server = spawn("node_modules/.bin/next", ["start", "--port", String(port)], { cwd: process.cwd(), env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", PRISMA_QUERY_ENGINE_LIBRARY: resolve(process.cwd(), "../../lib/generated/prisma/libquery_engine-debian-openssl-3.0.x.so.node") }, stdio: "ignore" });
  await waitForServer();
});

after(async () => {
  if (server && server.exitCode === null) await new Promise<void>((resolve) => { server?.once("exit", resolve); server?.kill("SIGTERM"); });
  const { minio, config } = getDirectUploadProviders();
  if (objectKey) await minio.removeObject(config.MINIO_BUCKET, objectKey).catch(() => undefined);
  if (datasetId) await db.dataset.deleteMany({ where: { id: { in: [datasetId, otherDatasetId].filter(Boolean) } } });
  await db.user.deleteMany({ where: { email: { in: [managerEmail, outsiderEmail, memberEmail].filter(Boolean) } } });
});

test("job status and events use PostgreSQL safe projections with member access and concealed denials", { skip: !enabled }, async () => {
  const [ownerCookie, memberCookie, outsiderCookie] = await Promise.all([login(managerEmail), login(memberEmail), login(outsiderEmail)]);
  const [owner, member, outsider, unknown, malformed] = await Promise.all([
    fetch(`${baseUrl}/api/jobs/${jobId}`, { headers: { Cookie: ownerCookie } }),
    fetch(`${baseUrl}/api/jobs/${jobId}`, { headers: { Cookie: memberCookie } }),
    fetch(`${baseUrl}/api/jobs/${jobId}`, { headers: { Cookie: outsiderCookie } }),
    fetch(`${baseUrl}/api/jobs/cmk0000000000000000000000`, { headers: { Cookie: outsiderCookie } }),
    fetch(`${baseUrl}/api/jobs/not-a-job`, { headers: { Cookie: outsiderCookie } }),
  ]);
  assert.equal(owner.status, 200); assert.equal(member.status, 200); assert.equal(outsider.status, 404); assert.equal(unknown.status, 404); assert.equal(malformed.status, 404);
  const body = await owner.json() as { data: Record<string, unknown> };
  assert.deepEqual(Object.keys(body.data).sort(), ["createdAt", "datasetId", "errorCode", "errorMessage", "failedCount", "finishedAt", "id", "jobId", "processedItems", "progress", "skippedCount", "stage", "startedAt", "status", "successCount", "summary", "totalItems", "type", "updatedAt"].sort());
  assert.equal(body.data.errorCode, "SOURCE_PROVIDER_UNAVAILABLE");
  assert.equal(JSON.stringify(body).includes("phase016-secret"), false);
  assert.equal(JSON.stringify(body).includes("repository-imports/private"), false);
  const events = await fetch(`${baseUrl}/api/jobs/${jobId}/events`, { headers: { Cookie: ownerCookie } }); assert.equal(events.status, 200);
  const eventBody = await events.json() as { data: { events: Array<Record<string, unknown>> } };
  assert.equal(eventBody.data.events.some((event) => event.message === "IMPORT_BATCH_COMPLETED"), true);
  assert.equal(JSON.stringify(eventBody).includes("phase016-secret"), false);
  assert.equal(JSON.stringify(eventBody).includes("storageKey"), false);
});

test("repository Job state APIs and progress page expose only public stage/status projections", { skip: !enabled }, async () => {
  const [ownerCookie, outsiderCookie] = await Promise.all([login(managerEmail), login(outsiderEmail)]);
  const expectedStages: Record<string, string | null> = {
    QUEUED: "WAITING",
    RUNNING: "UPLOADING_OBJECTS",
    RETRYING: "SCANNING",
    CANCELING: "WRITING_ASSETS",
    CANCELED: "FINISHED",
    FAILED: "SCANNING",
  };
  for (const [status, id] of stateJobIds) {
    const response = await fetch(`${baseUrl}/api/jobs/${id}`, { headers: { Cookie: ownerCookie } });
    assert.equal(response.status, 200, status);
    const body = await response.json() as { data: Record<string, unknown> };
    assert.equal(body.data.status, status);
    assert.equal(body.data.stage, expectedStages[status]);
    assert.equal(JSON.stringify(body).includes("phase016-state-secret"), false);
    assert.equal(JSON.stringify(body).includes("private-state"), false);
    const events = await fetch(`${baseUrl}/api/jobs/${id}/events`, { headers: { Cookie: ownerCookie } });
    assert.equal(events.status, 200, `${status} events`);
    const eventBody = await events.json() as { data: { events: Array<Record<string, unknown>> } };
    assert.equal(eventBody.data.events[0]?.stage, status === "QUEUED" ? null : expectedStages[status]);
    assert.equal(JSON.stringify(eventBody).includes("phase016-state-secret"), false);
    assert.equal(JSON.stringify(eventBody).includes("private-state"), false);
  }
  const runningId = stateJobIds.get("RUNNING")!;
  const [ownerPage, foreignPage, wrongDatasetPage, foreignState] = await Promise.all([
    fetch(`${baseUrl}/datasets/${datasetId}/imports/${runningId}`, { headers: { Cookie: ownerCookie } }),
    fetch(`${baseUrl}/datasets/${datasetId}/imports/${runningId}`, { headers: { Cookie: outsiderCookie } }),
    fetch(`${baseUrl}/datasets/${otherDatasetId}/imports/${runningId}`, { headers: { Cookie: ownerCookie } }),
    fetch(`${baseUrl}/api/jobs/${runningId}`, { headers: { Cookie: outsiderCookie } }),
  ]);
  assert.equal(ownerPage.status, 200);
  assert.equal(foreignPage.status, 404);
  assert.equal(wrongDatasetPage.status, 404);
  assert.equal(foreignState.status, 404);
  const rendered = await ownerPage.text();
  assert.equal(rendered.includes("phase016-state-secret"), false);
  assert.equal(rendered.includes("private-state"), false);
  assert.equal(rendered.includes("BullMQ"), false);
});

test("owner reads mirrored Asset metadata and view capability; outsider is concealed", { skip: !enabled }, async () => {
  const [managerCookie, outsiderCookie] = await Promise.all([login(managerEmail), login(outsiderEmail)]);
  const list = await fetch(`${baseUrl}/api/datasets/${datasetId}/assets?limit=25`, { headers: { Cookie: managerCookie } });
  assert.equal(list.status, 200);
  const listBody = await list.json() as { data: { items: Array<Record<string, unknown>> } };
  assert.equal(listBody.data.items.some((asset) => asset.id === assetId), true);
  assert.equal(JSON.stringify(listBody).includes(objectKey), false);
  const view = await fetch(`${baseUrl}/api/assets/${assetId}/view-url`, { headers: { Cookie: managerCookie } });
  assert.equal(view.status, 200);
  const viewBody = await view.json() as { data: Record<string, unknown> };
  assert.equal("storageKey" in viewBody.data, false);
  assert.equal("storageBucket" in viewBody.data, false);
  const deniedList = await fetch(`${baseUrl}/api/datasets/${datasetId}/assets`, { headers: { Cookie: outsiderCookie } });
  const deniedView = await fetch(`${baseUrl}/api/assets/${assetId}/view-url`, { headers: { Cookie: outsiderCookie } });
  assert.equal(deniedList.status, 404);
  assert.equal(deniedView.status, 404);
});
