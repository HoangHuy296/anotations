import assert from "node:assert/strict";
import test from "node:test";

import { hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { createJobQueueFixture, createQueueInspector, queueIntegrationSkipReason } from "./helpers";
import { loginForJobHttp, startJobHttpServer, stopJobHttpServer } from "./http-test-server";

test("authenticated HTTP export create is idempotent, authorized, durable, and safely projected", { skip: queueIntegrationSkipReason }, async () => {
  const fixture = await createJobQueueFixture();
  const queue = createQueueInspector();
  const password = "phase-twelve-export-create";
  let server: Awaited<ReturnType<typeof startJobHttpServer>> | undefined;
  let jobId = "";
  try {
    await db.user.updateMany({
      where: { id: { in: [fixture.owner.id, fixture.labeler.id, fixture.outsider.id] } },
      data: { passwordHash: await hashPassword(password) },
    });
    server = await startJobHttpServer(3_112);
    const [ownerCookie, labelerCookie, outsiderCookie] = await Promise.all([
      loginForJobHttp(server.baseUrl, fixture.owner.email, password),
      loginForJobHttp(server.baseUrl, fixture.labeler.email, password),
      loginForJobHttp(server.baseUrl, fixture.outsider.email, password),
    ]);
    const before = await db.job.count({ where: { datasetId: fixture.datasetId } });
    const request = (cookie: string, body: unknown) => fetch(`${server!.baseUrl}/api/export`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const denied = await request(labelerCookie, { datasetId: fixture.datasetId });
    assert.equal(denied.status, 403);
    assert.equal((await request(outsiderCookie, { datasetId: fixture.datasetId })).status, 404);
    assert.equal((await request(ownerCookie, { datasetId: fixture.datasetId, storageKey: "private" })).status, 400);
    assert.equal(await db.job.count({ where: { datasetId: fixture.datasetId } }), before);

    const created = await request(ownerCookie, { datasetId: fixture.datasetId });
    assert.equal(created.status, 201);
    const body = await created.json() as { data: { job: Record<string, unknown>; deliveryPending: boolean } };
    jobId = String(body.data.job.id);
    assert.equal(body.data.job.datasetId, fixture.datasetId);
    assert.equal(body.data.job.type, "EXPORT_DATASET");
    assert.equal(body.data.deliveryPending, false);
    for (const field of ["input", "state", "error", "queueName", "queueJobId", "lockToken", "resultStorageKey", "resultFilename"])
      assert.equal(field in body.data.job, false);
    const repeated = await request(ownerCookie, { datasetId: fixture.datasetId, format: "JSON", manifestSchemaVersion: "1" });
    assert.equal(repeated.status, 200);
    assert.equal(String(((await repeated.json()) as { data: { job: { id: string } } }).data.job.id), jobId);
    assert.equal(await db.job.count({ where: { datasetId: fixture.datasetId, type: "EXPORT_DATASET" } }), 1);
  } finally {
    if (jobId) await queue.remove(jobId);
    await queue.close();
    await stopJobHttpServer(server?.server);
    await fixture.cleanup();
  }
});
