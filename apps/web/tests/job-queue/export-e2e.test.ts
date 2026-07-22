import assert from "node:assert/strict";
import test from "node:test";

import { UserRole } from "@internal/db";

import { createFoundationWorker } from "../../../worker/src/queue/bullmq-worker.js";
import { getWorkerConfig } from "../../../worker/src/config.js";
import { hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { getDirectUploadProviders } from "@/lib/providers";
import { createJobQueueFixture, createQueueInspector, queueIntegrationSkipReason } from "./helpers";
import { loginForJobHttp, startJobHttpServer, stopJobHttpServer } from "./http-test-server";

const enabled = !queueIntegrationSkipReason && process.env.EXPORT_INTEGRATION_TESTS === "1"
  && Boolean(process.env.MINIO_ENDPOINT && process.env.MINIO_ACCESS_KEY && process.env.MINIO_SECRET_KEY && process.env.MINIO_BUCKET);

async function waitForExternalWeb(baseUrl: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/api/auth/me`)).status === 401) return;
    } catch { /* container is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Controlled Compose web service did not become ready.");
}

async function waitForTerminal(jobId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = await db.job.findUnique({ where: { id: jobId }, select: { status: true, resultStorageKey: true } });
    if (job && ["COMPLETED", "FAILED", "CANCELED"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Export Job did not reach a terminal PostgreSQL state.");
}

async function listPrefix(prefix: string) {
  const { config, minio } = getDirectUploadProviders();
  const names: string[] = [];
  for await (const item of minio.listObjectsV2(config.MINIO_BUCKET, prefix, true)) if (item.name) names.push(item.name);
  return names;
}

test("authenticated HTTP to PostgreSQL Job to BullMQ jobId to worker claim to MinIO to authorized download", { skip: !enabled }, async () => {
  const fixture = await createJobQueueFixture();
  const queue = createQueueInspector();
  const externalBaseUrl = process.env.EXPORT_E2E_BASE_URL;
  const useExternalWorker = process.env.EXPORT_E2E_EXTERNAL_WORKER === "1";
  const runtime = useExternalWorker ? undefined : createFoundationWorker({ config: getWorkerConfig(), db });
  const password = "phase-twelve-consolidated-e2e";
  const prefix = `exports/${fixture.datasetId}/`;
  let server: Awaited<ReturnType<typeof startJobHttpServer>> | undefined;
  let jobId = "";
  let artifactKey = "";
  try {
    await db.user.updateMany({ where: { id: { in: [fixture.owner.id, fixture.outsider.id] } }, data: { passwordHash: await hashPassword(password) } });
    const asset = await db.asset.create({
      data: {
        datasetId: fixture.datasetId, uploadedById: fixture.owner.id, modality: "IMAGE", filename: "e2e.jpg",
        mimeType: "image/jpeg", sizeBytes: BigInt(4), width: 2, height: 2, sourceFingerprint: `e2e-${Date.now()}`,
        storageProvider: "MINIO", storageBucket: "private-source", storageKey: "private-source/e2e.jpg", status: "COMPLETED",
      }, select: { id: true },
    });
    const label = await db.label.create({
      data: { datasetId: fixture.datasetId, modality: "IMAGE", name: "Object", normalizedName: `object-${Date.now()}`, color: "#000000" },
      select: { id: true },
    });
    await db.annotation.create({
      data: {
        datasetId: fixture.datasetId, assetId: asset.id, labelId: label.id, createdById: fixture.owner.id,
        modality: "IMAGE", type: "BOUNDING_BOX", geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
      },
    });
    assert.deepEqual(await listPrefix(prefix), []);
    if (externalBaseUrl) await waitForExternalWeb(externalBaseUrl);
    else server = await startJobHttpServer(3_115);
    const baseUrl = externalBaseUrl ?? server!.baseUrl;
    await runtime?.worker.waitUntilReady();
    const [ownerCookie, outsiderCookie] = await Promise.all([
      loginForJobHttp(baseUrl, fixture.owner.email, password),
      loginForJobHttp(baseUrl, fixture.outsider.email, password),
    ]);
    const jobCountBeforeDenial = await db.job.count({ where: { datasetId: fixture.datasetId } });
    const deniedCreate = await fetch(`${baseUrl}/api/export`, {
      method: "POST", headers: { Cookie: outsiderCookie, "Content-Type": "application/json" }, body: JSON.stringify({ datasetId: fixture.datasetId }),
    });
    assert.equal(deniedCreate.status, 404);
    assert.equal(await db.job.count({ where: { datasetId: fixture.datasetId } }), jobCountBeforeDenial);
    assert.deepEqual(await listPrefix(prefix), []);

    const created = await fetch(`${baseUrl}/api/export`, {
      method: "POST", headers: { Cookie: ownerCookie, "Content-Type": "application/json" }, body: JSON.stringify({ datasetId: fixture.datasetId }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json() as { data: { job: { id: string; type: string; status: string }; deliveryPending: boolean } };
    jobId = createdBody.data.job.id;
    assert.equal(createdBody.data.job.type, "EXPORT_DATASET");
    assert.equal(createdBody.data.deliveryPending, false);
    const delivery = await queue.find(jobId);
    assert.ok(delivery);
    assert.deepEqual(delivery.data, { jobId });

    const terminal = await waitForTerminal(jobId);
    assert.equal(terminal.status, "COMPLETED");
    assert.ok(terminal.resultStorageKey);
    artifactKey = terminal.resultStorageKey;
    const stored = await db.job.findUniqueOrThrow({
      where: { id: jobId },
      select: {
        status: true, stage: true, progress: true, totalItems: true, processedItems: true, successItems: true,
        queueName: true, queueJobId: true, enqueuedAt: true, dequeuedAt: true, resultFilename: true, lockToken: true,
      },
    });
    assert.equal(stored.status, "COMPLETED");
    assert.equal(stored.stage, "FINISHED");
    assert.equal(stored.progress, 100);
    assert.equal(stored.totalItems, stored.processedItems);
    assert.equal(stored.processedItems, stored.successItems);
    assert.ok(stored.queueName && stored.queueJobId && stored.enqueuedAt && stored.dequeuedAt && stored.resultFilename);
    assert.equal(stored.lockToken, null);
    assert.deepEqual(await listPrefix(prefix), [artifactKey]);
    assert.equal(await db.jobEvent.count({ where: { jobId, message: { in: ["QUEUE_ENQUEUED", "QUEUE_RECEIVED", "JOB_CLAIMED", "JOB_PROGRESS", "JOB_COMPLETED"] } } }), 5);

    const safeStatus = await fetch(`${baseUrl}/api/export/${jobId}`, { headers: { Cookie: ownerCookie } });
    assert.equal(safeStatus.status, 200);
    const statusBody = await safeStatus.json() as { data: { job: Record<string, unknown>; download: { url: string; expiresAt: string; filename: string } } };
    for (const field of ["input", "state", "queueName", "queueJobId", "lockToken", "resultStorageKey", "resultFilename"])
      assert.equal(field in statusBody.data.job, false);
    const downloaded = await fetch(statusBody.data.download.url);
    assert.equal(downloaded.status, 200);
    const manifest = await downloaded.json() as { schemaVersion: string; dataset: { id: string }; assets: unknown[]; labels: unknown[]; annotations: unknown[] };
    assert.equal(manifest.schemaVersion, "1");
    assert.equal(manifest.dataset.id, fixture.datasetId);
    assert.equal(manifest.assets.length, 1);
    assert.equal(manifest.labels.length, 1);
    assert.equal(manifest.annotations.length, 1);
    const serializedManifest = JSON.stringify(manifest);
    for (const value of ["storageBucket", "storageKey", "private-source/e2e.jpg", "credential", "lockToken"])
      assert.equal(serializedManifest.includes(value), false);

    const eventsBeforeDenials = await db.jobEvent.count({ where: { jobId } });
    assert.equal((await fetch(`${baseUrl}/api/export/${jobId}`, { headers: { Cookie: outsiderCookie } })).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/jobs/${jobId}/cancel`, { method: "POST", headers: { Cookie: outsiderCookie } })).status, 404);
    assert.equal(await db.jobEvent.count({ where: { jobId } }), eventsBeforeDenials);
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: fixture.owner.id }, select: { role: true } })).role, UserRole.MANAGER);
  } finally {
    await runtime?.close();
    if (jobId) await queue.remove(jobId);
    await queue.close();
    await stopJobHttpServer(server?.server);
    if (artifactKey) {
      const { config, minio } = getDirectUploadProviders();
      await minio.removeObject(config.MINIO_BUCKET, artifactKey).catch(() => undefined);
    }
    await fixture.cleanup();
  }
});
