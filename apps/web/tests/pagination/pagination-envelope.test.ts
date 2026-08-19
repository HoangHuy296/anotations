import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import { RepoAuthType, RepoProvider, SourceConnectionStatus, UserRole } from "@internal/db";

import { hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { loginForJobHttp, startJobHttpServer, stopJobHttpServer } from "../job-queue/http-test-server";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL);
const port = 3_121;
const password = "pagination-envelope-password";

let server: Awaited<ReturnType<typeof startJobHttpServer>>["server"] | undefined;
let baseUrl = "";
const createdUserIds: string[] = [];
const createdDatasetIds: string[] = [];
const createdAiModelIds: string[] = [];

before(async () => {
  if (!hasIntegrationDatabase) return;
  const started = await startJobHttpServer(port);
  server = started.server;
  baseUrl = started.baseUrl;
});

after(async () => {
  await stopJobHttpServer(server);
  if (createdAiModelIds.length) await db.aiModel.deleteMany({ where: { id: { in: createdAiModelIds } } });
  if (createdDatasetIds.length) await db.dataset.deleteMany({ where: { id: { in: createdDatasetIds } } });
  if (createdUserIds.length) await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

/**
 * Every test gets its own freshly-created MANAGER user. `GET /api/datasets`
 * and `GET /api/source-connections` are already actor-scoped queries
 * (Dataset ownership/membership, SourceConnection.userId), so a fresh user
 * with no prior data makes their `total` exactly this test's fixture count
 * with no risk of counting other tests' or other developers' rows in the
 * shared dev database -- the lesson from the JobEvent-retention incident
 * earlier in this feature.
 */
async function freshLoggedInUser() {
  const uniqueSuffix = randomUUID();
  const email = `pagination-${uniqueSuffix}@test.invalid`;
  const user = await db.user.create({ data: { email, passwordHash: await hashPassword(password), role: UserRole.MANAGER }, select: { id: true } });
  createdUserIds.push(user.id);
  const cookie = await loginForJobHttp(baseUrl, email, password);
  return { userId: user.id, cookie };
}

test("GET /api/datasets: page/pageSize/total envelope, clamped page size, and out-of-range page returns empty items", { skip: !hasIntegrationDatabase }, async () => {
  const { userId, cookie } = await freshLoggedInUser();
  const suffix = randomBytes(4).toString("hex");
  const datasets = await Promise.all(
    Array.from({ length: 3 }, (_, index) => db.dataset.create({ data: { ownerId: userId, name: `pagination-ds-${suffix}-${index}` }, select: { id: true } })),
  );
  createdDatasetIds.push(...datasets.map((dataset) => dataset.id));

  const firstPage = await fetch(`${baseUrl}/api/datasets?page=1&pageSize=2`, { headers: { Cookie: cookie } });
  assert.equal(firstPage.status, 200);
  const firstBody = await firstPage.json() as { data: { items: unknown[]; page: number; pageSize: number; total: number } };
  assert.equal(firstBody.data.items.length, 2);
  assert.equal(firstBody.data.page, 1);
  assert.equal(firstBody.data.pageSize, 2);
  assert.equal(firstBody.data.total, 3);

  const secondPage = await fetch(`${baseUrl}/api/datasets?page=2&pageSize=2`, { headers: { Cookie: cookie } });
  const secondBody = await secondPage.json() as { data: { items: unknown[]; total: number } };
  assert.equal(secondBody.data.items.length, 1);
  assert.equal(secondBody.data.total, 3);

  // A page far beyond the last page is never an error -- empty items, real total, 200 OK.
  const beyondLastPage = await fetch(`${baseUrl}/api/datasets?page=99&pageSize=2`, { headers: { Cookie: cookie } });
  assert.equal(beyondLastPage.status, 200);
  const beyondBody = await beyondLastPage.json() as { data: { items: unknown[]; total: number } };
  assert.equal(beyondBody.data.items.length, 0);
  assert.equal(beyondBody.data.total, 3);

  // A caller-requested pageSize above the server's configured ceiling is silently
  // clamped, never rejected.
  const overCap = await fetch(`${baseUrl}/api/datasets?pageSize=100000`, { headers: { Cookie: cookie } });
  const overCapBody = await overCap.json() as { data: { items: unknown[]; pageSize: number; total: number } };
  assert.equal(overCap.status, 200);
  assert.ok(overCapBody.data.pageSize <= 1_000, "pageSize must be clamped, never echoed back unbounded");
  assert.equal(overCapBody.data.items.length, 3);
});

test("GET /api/datasets/{datasetId}/labels: pagination envelope, defaults return the full taxonomy dataset-labels-store.ts relies on", { skip: !hasIntegrationDatabase }, async () => {
  const { userId, cookie } = await freshLoggedInUser();
  const suffix = randomBytes(4).toString("hex");
  const dataset = await db.dataset.create({ data: { ownerId: userId, name: `pagination-labels-${suffix}` }, select: { id: true } });
  createdDatasetIds.push(dataset.id);
  await db.label.createMany({
    data: Array.from({ length: 3 }, (_, index) => ({ datasetId: dataset.id, name: `Label ${index}`, normalizedName: `label ${index}`, color: "#0EA5E9" })),
  });

  // No query params, exactly like `dataset-labels-store.ts`'s `ensureLoaded` fetch --
  // must keep returning the full set, not a truncated first page.
  const unparameterized = await fetch(`${baseUrl}/api/datasets/${dataset.id}/labels`, { headers: { Cookie: cookie } });
  assert.equal(unparameterized.status, 200);
  const unparameterizedBody = await unparameterized.json() as { data: { items: unknown[]; page: number; pageSize: number; total: number } };
  assert.equal(unparameterizedBody.data.items.length, 3, "an un-paginated caller must keep receiving the dataset's full label taxonomy");
  assert.equal(unparameterizedBody.data.page, 1);
  assert.equal(unparameterizedBody.data.total, 3);

  const paged = await fetch(`${baseUrl}/api/datasets/${dataset.id}/labels?page=1&pageSize=2`, { headers: { Cookie: cookie } });
  const pagedBody = await paged.json() as { data: { items: unknown[]; total: number } };
  assert.equal(pagedBody.data.items.length, 2);
  assert.equal(pagedBody.data.total, 3);
});

test("GET /api/source-connections: page/pageSize/total envelope alongside the existing 'connections' key", { skip: !hasIntegrationDatabase }, async () => {
  const { userId, cookie } = await freshLoggedInUser();
  const suffix = randomBytes(4).toString("hex");
  await db.sourceConnection.createMany({
    data: Array.from({ length: 2 }, (_, index) => ({
      userId, provider: RepoProvider.GITEA, authType: RepoAuthType.TOKEN, baseUrl: "https://gitea.test.invalid",
      externalAccountId: `pagination-${suffix}-${index}`, status: SourceConnectionStatus.ACTIVE,
    })),
  });

  const response = await fetch(`${baseUrl}/api/source-connections`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const body = await response.json() as { data: { connections: unknown[]; page: number; pageSize: number; total: number } };
  assert.equal(body.data.connections.length, 2);
  assert.equal(body.data.page, 1);
  assert.equal(body.data.total, 2);
});

test("GET /api/ai/models: page/pageSize/total envelope alongside the existing 'models' key; total matches the live active-model count", { skip: !hasIntegrationDatabase }, async () => {
  const { cookie } = await freshLoggedInUser();
  const suffix = randomBytes(4).toString("hex");
  const model = await db.aiModel.create({
    data: { key: `pagination-model-${suffix}`, displayName: "Pagination Fixture Model", provider: "aioz-company", modality: "IMAGE", taskType: "DETECT_OBJECTS", isActive: true },
    select: { id: true },
  });
  createdAiModelIds.push(model.id);

  // The active-model catalog is genuinely global (no per-user/per-dataset scope in
  // `listActiveAiModels`), so assert against a live count taken immediately before
  // the request rather than any fixed absolute number -- other active models may
  // already exist in this shared dev database.
  const expectedTotal = await db.aiModel.count({ where: { isActive: true } });
  const response = await fetch(`${baseUrl}/api/ai/models`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const body = await response.json() as { data: { models: Array<{ id: string }>; page: number; pageSize: number; total: number } };
  assert.equal(body.data.total, expectedTotal);
  assert.ok(body.data.models.some((entry) => entry.id === model.id), "the newly created active model must appear in the (unpaginated-by-default) list");
});

test("GET /api/assets/{assetId}/annotations: defensive cap only -- response shape is unchanged, page/pageSize query params are not truncating", { skip: !hasIntegrationDatabase }, async () => {
  const { userId, cookie } = await freshLoggedInUser();
  const suffix = randomBytes(4).toString("hex");
  const dataset = await db.dataset.create({ data: { ownerId: userId, name: `pagination-annotations-${suffix}` }, select: { id: true } });
  createdDatasetIds.push(dataset.id);
  const asset = await db.asset.create({
    data: { datasetId: dataset.id, modality: "IMAGE", filename: `pagination-${suffix}.jpg`, mimeType: "image/jpeg", sourceFingerprint: `pagination-${suffix}` },
    select: { id: true },
  });
  await db.annotation.createMany({
    data: Array.from({ length: 3 }, () => ({
      assetId: asset.id, datasetId: dataset.id, modality: "IMAGE" as const, type: "BOUNDING_BOX" as const,
      geometry: { x: 0, y: 0, width: 10, height: 10 }, createdById: userId,
    })),
  });

  // AI-detect-apply-results (image-engine.tsx) depends on getting every annotation
  // back regardless of count -- passing page/pageSize here must have no truncating
  // effect at all, unlike the four routes above.
  const response = await fetch(`${baseUrl}/api/assets/${asset.id}/annotations?page=1&pageSize=1`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const body = await response.json() as { data: Record<string, unknown> };
  assert.equal((body.data.annotations as unknown[]).length, 3, "page/pageSize query params must not truncate this endpoint's response");
  assert.equal("page" in body.data, false, "this endpoint keeps its original bare-array shape, not the pagination envelope");
  assert.equal("pageSize" in body.data, false);
  assert.equal("total" in body.data, false);
});
