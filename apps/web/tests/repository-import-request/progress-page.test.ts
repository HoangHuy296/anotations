import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { JobStatus, JobType } from "@internal/db";

import { db } from "@/lib/db";

import {
  cleanupRepositoryImportUser,
  repositoryImportHttpEnabled,
  repositoryImportHttpSkipReason,
  registerAndLoginRepositoryImportUser,
} from "./helpers";

const baseUrl = process.env.REPOSITORY_PREFLIGHT_HTTP_BASE_URL ?? "";

test("the Dataset-scoped import progress page and Job API use safe PostgreSQL projections and conceal foreign Jobs", {
  skip: repositoryImportHttpEnabled ? false : repositoryImportHttpSkipReason,
  concurrency: false,
}, async () => {
  const owner = await registerAndLoginRepositoryImportUser();
  const foreign = await registerAndLoginRepositoryImportUser();
  let datasetId = "";
  try {
    const sentinel = `phase015-progress-${randomBytes(12).toString("hex")}`;
    const dataset = await db.dataset.create({ data: { ownerId: owner.userId, name: `phase015-progress-${randomBytes(6).toString("hex")}` }, select: { id: true } });
    datasetId = dataset.id;
    const job = await db.job.create({
      data: {
        datasetId,
        createdById: owner.userId,
        type: JobType.IMPORT_DATASET,
        status: JobStatus.QUEUED,
        input: { sentinel, source: { repository: { owner: "fixture", repo: "public-images" } } },
      },
      select: { id: true },
    });

    const status = await fetch(`${baseUrl}/api/jobs/${job.id}`, { headers: { Cookie: owner.cookie } });
    assert.equal(status.status, 200);
    const statusPayload = await status.json() as { data?: Record<string, unknown> };
    assert.deepEqual(Object.keys(statusPayload.data ?? {}).sort(), [
      "createdAt", "datasetId", "errorCode", "errorMessage", "failedCount", "finishedAt", "id", "jobId", "processedItems", "progress", "skippedCount", "stage", "startedAt", "status", "successCount", "summary", "totalItems", "type", "updatedAt",
    ]);
    assert.equal(JSON.stringify(statusPayload).includes(sentinel), false);
    assert.equal(JSON.stringify(statusPayload).includes("input"), false);

    const page = await fetch(`${baseUrl}/datasets/${datasetId}/imports/${job.id}`, { headers: { Cookie: owner.cookie } });
    assert.equal(page.status, 200);
    const ownerHtml = await page.text();
    assert.equal(ownerHtml.includes(sentinel), false);

    const foreignStatus = await fetch(`${baseUrl}/api/jobs/${job.id}`, { headers: { Cookie: foreign.cookie } });
    assert.equal(foreignStatus.status, 404);
    const foreignPayload = await foreignStatus.json() as { error?: { code?: string } };
    assert.equal(foreignPayload.error?.code, "JOB_NOT_FOUND");
    assert.equal(JSON.stringify(foreignPayload).includes(sentinel), false);

    const foreignPage = await fetch(`${baseUrl}/datasets/${datasetId}/imports/${job.id}`, { headers: { Cookie: foreign.cookie }, redirect: "manual" });
    assert.equal(foreignPage.status, 404);
    assert.equal((await foreignPage.text()).includes(sentinel), false);
  } finally {
    if (datasetId) await db.dataset.delete({ where: { id: datasetId } }).catch(() => undefined);
    await cleanupRepositoryImportUser(owner.userId);
    await cleanupRepositoryImportUser(foreign.userId);
  }
});
