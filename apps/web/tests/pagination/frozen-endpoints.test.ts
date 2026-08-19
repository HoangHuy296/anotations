import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import { JobStatus, JobType, Modality, UserRole } from "@internal/db";

import { hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { loginForJobHttp, startJobHttpServer, stopJobHttpServer } from "../job-queue/http-test-server";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL);
const port = 3_122;
const password = "frozen-endpoints-password";

let server: Awaited<ReturnType<typeof startJobHttpServer>>["server"] | undefined;
let baseUrl = "";
const createdUserIds: string[] = [];
const createdDatasetIds: string[] = [];

before(async () => {
  if (!hasIntegrationDatabase) return;
  const started = await startJobHttpServer(port);
  server = started.server;
  baseUrl = started.baseUrl;
});

after(async () => {
  await stopJobHttpServer(server);
  if (createdDatasetIds.length) await db.dataset.deleteMany({ where: { id: { in: createdDatasetIds } } });
  if (createdUserIds.length) await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

async function freshLoggedInUser() {
  const email = `frozen-endpoints-${randomUUID()}@test.invalid`;
  const user = await db.user.create({ data: { email, passwordHash: await hashPassword(password), role: UserRole.MANAGER }, select: { id: true } });
  createdUserIds.push(user.id);
  const cookie = await loginForJobHttp(baseUrl, email, password);
  return { userId: user.id, cookie };
}

/**
 * Guard against accidental scope creep in T068-T071: `contracts/
 * pagination-envelope.md` explicitly excludes these two endpoints (already
 * cursor-paginated, contract frozen). Neither has been touched by this
 * feature's pagination work -- this test proves their response shapes stay
 * exactly what they were: `{ items, page: { limit, nextCursor, hasNextPage } }`
 * and `{ events, nextCursor }`, never the new `{ items/models/connections,
 * page, pageSize, total }` offset envelope applied elsewhere.
 */
test("GET /api/datasets/{datasetId}/assets keeps its cursor-pagination shape, not the new offset envelope", { skip: !hasIntegrationDatabase }, async () => {
  const { userId, cookie } = await freshLoggedInUser();
  const suffix = randomBytes(4).toString("hex");
  const dataset = await db.dataset.create({ data: { ownerId: userId, name: `frozen-assets-${suffix}` }, select: { id: true } });
  createdDatasetIds.push(dataset.id);
  await db.asset.create({
    data: { datasetId: dataset.id, modality: Modality.IMAGE, filename: `frozen-${suffix}.jpg`, mimeType: "image/jpeg", sourceFingerprint: `frozen-${suffix}` },
  });

  const response = await fetch(`${baseUrl}/api/datasets/${dataset.id}/assets`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const body = await response.json() as { data: Record<string, unknown> };
  assert.deepEqual(Object.keys(body.data).sort(), ["items", "page"]);
  const page = body.data.page as Record<string, unknown>;
  assert.deepEqual(Object.keys(page).sort(), ["hasNextPage", "limit", "nextCursor"]);
  assert.equal("pageSize" in page, false);
  assert.equal("total" in page, false);
});

test("GET /api/jobs/{jobId}/events keeps its cursor-pagination shape, not the new offset envelope", { skip: !hasIntegrationDatabase }, async () => {
  const { userId, cookie } = await freshLoggedInUser();
  const suffix = randomBytes(4).toString("hex");
  const dataset = await db.dataset.create({ data: { ownerId: userId, name: `frozen-events-${suffix}` }, select: { id: true } });
  createdDatasetIds.push(dataset.id);
  const job = await db.job.create({
    data: { datasetId: dataset.id, createdById: userId, type: JobType.EXPORT_DATASET, status: JobStatus.QUEUED, input: {} },
    select: { id: true },
  });
  await db.jobEvent.create({ data: { jobId: job.id, message: "QUEUE_ENQUEUED" } });

  const response = await fetch(`${baseUrl}/api/jobs/${job.id}/events`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const body = await response.json() as { data: Record<string, unknown> };
  assert.deepEqual(Object.keys(body.data).sort(), ["events", "nextCursor"]);
  assert.equal("page" in body.data, false);
  assert.equal("pageSize" in body.data, false);
  assert.equal("total" in body.data, false);
});
