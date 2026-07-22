import assert from "node:assert/strict";
import test from "node:test";

import { hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { getDirectUploadProviders } from "@/lib/providers";
import { createJobQueueFixture } from "./helpers";
import { loginForJobHttp, startJobHttpServer, stopJobHttpServer } from "./http-test-server";

const enabled = process.env.EXPORT_INTEGRATION_TESTS === "1"
  && Boolean(process.env.DATABASE_URL && process.env.MINIO_ACCESS_KEY && process.env.MINIO_SECRET_KEY && process.env.MINIO_BUCKET);
if (enabled) {
  process.env.MINIO_ENDPOINT = "http://localhost:9000";
  process.env.MINIO_PUBLIC_ENDPOINT = "http://localhost:9000";
}

test("authorized download capability yields the redacted metadata manifest only", { skip: !enabled }, async () => {
  const fixture = await createJobQueueFixture();
  const password = "phase-twelve-export-download";
  const key = `exports/${fixture.datasetId}/download-test/manifest-v1.json`;
  let server: Awaited<ReturnType<typeof startJobHttpServer>> | undefined;
  try {
    const { config, minio } = getDirectUploadProviders();
    const manifest = {
      schemaVersion: "1", exportedAt: new Date(0).toISOString(),
      dataset: { id: fixture.datasetId, name: "safe" }, assets: [], labels: [], annotations: [],
    };
    const body = Buffer.from(JSON.stringify(manifest));
    await minio.putObject(config.MINIO_BUCKET, key, body, body.byteLength, { "Content-Type": "application/json" });
    const job = await db.job.create({
      data: {
        datasetId: fixture.datasetId, createdById: fixture.owner.id, type: "EXPORT_DATASET", status: "COMPLETED",
        resultStorageKey: key, resultFilename: "dataset-export.json", finishedAt: new Date(), progress: 100,
      }, select: { id: true },
    });
    await db.user.updateMany({ where: { id: { in: [fixture.owner.id, fixture.outsider.id] } }, data: { passwordHash: await hashPassword(password) } });
    server = await startJobHttpServer(3_114);
    const [ownerCookie, outsiderCookie] = await Promise.all([
      loginForJobHttp(server.baseUrl, fixture.owner.email, password),
      loginForJobHttp(server.baseUrl, fixture.outsider.email, password),
    ]);
    assert.equal((await fetch(`${server.baseUrl}/api/export/${job.id}`, { headers: { Cookie: outsiderCookie } })).status, 404);
    const response = await fetch(`${server.baseUrl}/api/export/${job.id}`, { headers: { Cookie: ownerCookie } });
    assert.equal(response.status, 200);
    const payload = await response.json() as { data: { download: { url: string; expiresAt: string; filename: string }; job: Record<string, unknown> } };
    assert.equal(payload.data.download.filename, "dataset-export.json");
    assert.ok(Number.isFinite(Date.parse(payload.data.download.expiresAt)));
    assert.equal("resultStorageKey" in payload.data.job, false);
    assert.deepEqual(Object.keys(payload.data.download).sort(), ["expiresAt", "filename", "url"]);
    const responseWithoutApprovedCapability = JSON.stringify({ ...payload, data: { ...payload.data, download: { ...payload.data.download, url: "<short-lived-capability>" } } });
    assert.equal(responseWithoutApprovedCapability.includes(key), false);
    assert.equal(responseWithoutApprovedCapability.includes(config.MINIO_BUCKET), false);
    const downloaded = await fetch(payload.data.download.url);
    assert.equal(downloaded.status, 200);
    assert.deepEqual(await downloaded.json(), manifest);
  } finally {
    await stopJobHttpServer(server?.server);
    const { config, minio } = getDirectUploadProviders();
    await minio.removeObject(config.MINIO_BUCKET, key).catch(() => undefined);
    await fixture.cleanup();
  }
});
