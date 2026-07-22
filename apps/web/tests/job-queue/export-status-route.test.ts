import assert from "node:assert/strict";
import test from "node:test";

import { hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { createJobQueueFixture, queueIntegrationSkipReason } from "./helpers";
import { loginForJobHttp, startJobHttpServer, stopJobHttpServer } from "./http-test-server";

test("authenticated export status is PostgreSQL-backed, concealed, and redacted", { skip: queueIntegrationSkipReason }, async () => {
  const fixture = await createJobQueueFixture();
  const password = "phase-twelve-export-status";
  let server: Awaited<ReturnType<typeof startJobHttpServer>> | undefined;
  try {
    await db.user.updateMany({
      where: { id: { in: [fixture.owner.id, fixture.labeler.id, fixture.outsider.id] } },
      data: { passwordHash: await hashPassword(password) },
    });
    const job = await db.job.create({
      data: {
        datasetId: fixture.datasetId, createdById: fixture.owner.id, type: "EXPORT_DATASET", status: "RUNNING",
        input: { privateToken: "must-not-leak" }, state: { objectKey: "must-not-leak" }, summary: { unsafe: "must-not-leak" },
        queueName: "private", queueJobId: "private", lockToken: "private", resultStorageKey: "private",
      }, select: { id: true },
    });
    server = await startJobHttpServer(3_113);
    const [ownerCookie, labelerCookie, outsiderCookie] = await Promise.all([
      loginForJobHttp(server.baseUrl, fixture.owner.email, password),
      loginForJobHttp(server.baseUrl, fixture.labeler.email, password),
      loginForJobHttp(server.baseUrl, fixture.outsider.email, password),
    ]);
    assert.equal((await fetch(`${server.baseUrl}/api/export/${job.id}`)).status, 401);
    assert.equal((await fetch(`${server.baseUrl}/api/export/${job.id}`, { headers: { Cookie: outsiderCookie } })).status, 404);
    assert.equal((await fetch(`${server.baseUrl}/api/export/${job.id}`, { headers: { Cookie: labelerCookie } })).status, 200);
    const response = await fetch(`${server.baseUrl}/api/export/${job.id}`, { headers: { Cookie: ownerCookie } });
    assert.equal(response.status, 200);
    const body = await response.json() as { data: { job: Record<string, unknown>; download: unknown } };
    assert.equal(body.data.job.id, job.id);
    assert.equal(body.data.job.summary, null);
    assert.equal(body.data.download, null);
    const serialized = JSON.stringify(body);
    for (const prohibited of ["input", "state", "resultStorageKey", "queueName", "queueJobId", "lockToken", "must-not-leak"])
      assert.equal(serialized.includes(prohibited), false);
  } finally {
    await stopJobHttpServer(server?.server);
    await fixture.cleanup();
  }
});
