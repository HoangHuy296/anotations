import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import { UserRole } from "@internal/db";

import { getProductionHardeningPolicy } from "@/lib/config/production-hardening";
import { hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { loginForJobHttp, startJobHttpServer, stopJobHttpServer } from "../job-queue/http-test-server";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL);
const port = 3_118;
const password = "route-enforcement-password";

let server: Awaited<ReturnType<typeof startJobHttpServer>>["server"] | undefined;
let baseUrl = "";
const createdUserIds: string[] = [];

before(async () => {
  if (!hasIntegrationDatabase) return;
  const started = await startJobHttpServer(port);
  server = started.server;
  baseUrl = started.baseUrl;
});

after(async () => {
  await stopJobHttpServer(server);
  if (createdUserIds.length) await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

/**
 * Every test below gets its own freshly-created user (never shared across
 * tests) — the rate-limit counter key is `ratelimit:{userId}:{category}:...`,
 * scoped by *category*, not by route path, so three different routes in the
 * same "import" category would otherwise silently share one counter and
 * contaminate each other's expected request counts if they reused a user.
 */
async function freshLoggedInUser() {
  const uniqueSuffix = randomUUID();
  const email = `rate-limit-${uniqueSuffix}@test.invalid`;
  const user = await db.user.create({ data: { email, passwordHash: await hashPassword(password), role: UserRole.MANAGER }, select: { id: true } });
  createdUserIds.push(user.id);
  const cookie = await loginForJobHttp(baseUrl, email, password);
  return cookie;
}

/**
 * Every route under test places its `enforceRateLimit` call immediately
 * after the auth check, before any body validation — so an empty/invalid
 * body is sufficient to exercise the rate-limit gate itself: staying under
 * the limit must produce whatever the route's own normal
 * validation-failure response is (never 429), and exceeding it must always
 * produce exactly the `contracts/rate-limit-error.md` 429 shape, with no
 * `Job`/`PreparedImport`/`AiTask` created for the rejected request.
 */
async function exerciseRoute(cookie: string, path: string, limit: number) {
  const responses: Response[] = [];
  for (let i = 0; i < limit + 1; i += 1) {
    responses.push(await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({}),
    }));
  }
  return responses;
}

test("POST /api/ai/tasks: requests beyond the configured limit are rejected with the RATE_LIMITED contract", { skip: !hasIntegrationDatabase }, async () => {
  const cookie = await freshLoggedInUser();
  const limit = getProductionHardeningPolicy().RATE_LIMIT_AI_TASK_PER_MINUTE;
  const before = await db.aiTask.count();
  const responses = await exerciseRoute(cookie, "/api/ai/tasks", limit);

  const within = responses.slice(0, limit);
  const excess = responses[responses.length - 1]!;
  for (const response of within) assert.notEqual(response.status, 429, "a within-limit request must never be rejected as rate-limited");
  assert.equal(excess.status, 429);
  const body = await excess.json() as { error: { code: string } };
  assert.equal(body.error.code, "RATE_LIMITED");
  assert.equal(excess.headers.has("retry-after"), true);
  assert.equal(await db.aiTask.count(), before, "no AiTask row was created by the rejected request");
});

test("POST /api/imports/local-folder: requests beyond the configured limit are rejected", { skip: !hasIntegrationDatabase }, async () => {
  const cookie = await freshLoggedInUser();
  const limit = getProductionHardeningPolicy().RATE_LIMIT_IMPORT_PER_MINUTE;
  const responses = await exerciseRoute(cookie, "/api/imports/local-folder", limit);
  const excess = responses[responses.length - 1]!;
  assert.equal(excess.status, 429);
  const body = await excess.json() as { error: { code: string } };
  assert.equal(body.error.code, "RATE_LIMITED");
});

test("POST /api/datasets/from-repository: requests beyond the configured limit are rejected", { skip: !hasIntegrationDatabase }, async () => {
  const cookie = await freshLoggedInUser();
  const limit = getProductionHardeningPolicy().RATE_LIMIT_IMPORT_PER_MINUTE;
  const responses = await exerciseRoute(cookie, "/api/datasets/from-repository", limit);
  const excess = responses[responses.length - 1]!;
  assert.equal(excess.status, 429);
  const body = await excess.json() as { error: { code: string } };
  assert.equal(body.error.code, "RATE_LIMITED");
});

test("POST /api/datasets/[datasetId]/imports/local-folder: requests beyond the configured limit are rejected", { skip: !hasIntegrationDatabase }, async () => {
  const cookie = await freshLoggedInUser();
  const limit = getProductionHardeningPolicy().RATE_LIMIT_IMPORT_PER_MINUTE;
  // Any string works as the URL path segment here — the rate-limit check
  // runs before this route ever validates/looks up the dataset id.
  const responses = await exerciseRoute(cookie, "/api/datasets/nonexistent-dataset-id/imports/local-folder", limit);
  const excess = responses[responses.length - 1]!;
  assert.equal(excess.status, 429);
  const body = await excess.json() as { error: { code: string } };
  assert.equal(body.error.code, "RATE_LIMITED");
});

test("POST /api/export: requests beyond the configured limit are rejected", { skip: !hasIntegrationDatabase }, async () => {
  const cookie = await freshLoggedInUser();
  const limit = getProductionHardeningPolicy().RATE_LIMIT_EXPORT_PER_MINUTE;
  const before = await db.job.count({ where: { type: "EXPORT_DATASET" } });
  const responses = await exerciseRoute(cookie, "/api/export", limit);
  const within = responses.slice(0, limit);
  const excess = responses[responses.length - 1]!;
  for (const response of within) assert.notEqual(response.status, 429);
  assert.equal(excess.status, 429);
  assert.equal(await db.job.count({ where: { type: "EXPORT_DATASET" } }), before, "no export Job was created by the rejected request");
});

test("a legitimate request within budget is never blocked by rate limiting", { skip: !hasIntegrationDatabase }, async () => {
  const cookie = await freshLoggedInUser();
  const response = await fetch(`${baseUrl}/api/ai/tasks`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({}) });
  assert.notEqual(response.status, 429, "the very first request against a fresh, untouched window must never be rejected as rate-limited");
});
