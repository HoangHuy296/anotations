import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import { UserRole } from "@internal/db";

import { hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { loginForJobHttp, startJobHttpServer, stopJobHttpServer } from "../job-queue/http-test-server";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL);
const port = 3_117;
const password = "health-observability-password";

let server: Awaited<ReturnType<typeof startJobHttpServer>>["server"] | undefined;
let baseUrl = "";
const suffix = randomUUID();
const adminEmail = `health-admin-${suffix}@test.invalid`;
const managerEmail = `health-manager-${suffix}@test.invalid`;
const userIds: string[] = [];

before(async () => {
  if (!hasIntegrationDatabase) return;
  const passwordHash = await hashPassword(password);
  const admin = await db.user.create({ data: { email: adminEmail, passwordHash, role: UserRole.ADMIN }, select: { id: true } });
  const manager = await db.user.create({ data: { email: managerEmail, passwordHash, role: UserRole.MANAGER }, select: { id: true } });
  userIds.push(admin.id, manager.id);
  const started = await startJobHttpServer(port);
  server = started.server;
  baseUrl = started.baseUrl;
});

after(async () => {
  await stopJobHttpServer(server);
  if (userIds.length) await db.user.deleteMany({ where: { id: { in: userIds } } });
});

test("an unauthenticated caller receives only { status }", { skip: !hasIntegrationDatabase }, async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  const body = await response.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ["status"]);
  assert.ok(response.status === 200 || response.status === 503);
});

test("an authenticated non-ADMIN caller also receives only { status }", { skip: !hasIntegrationDatabase }, async () => {
  const cookie = await loginForJobHttp(baseUrl, managerEmail, password);
  const response = await fetch(`${baseUrl}/api/health`, { headers: { Cookie: cookie } });
  const body = await response.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ["status"]);
});

test("an ADMIN caller receives the full checks/jobs body", { skip: !hasIntegrationDatabase }, async () => {
  const cookie = await loginForJobHttp(baseUrl, adminEmail, password);
  const response = await fetch(`${baseUrl}/api/health`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const body = await response.json() as {
    status: string;
    checks: { postgres: { ready: boolean }; redis: { ready: boolean }; minio: { ready: boolean } };
    jobs: { queueBacklog: number | null; active: number; failed: number; stale: number; retrying: number; deadLettered: number };
  };
  assert.equal(body.status, "ready");
  assert.equal(body.checks.postgres.ready, true);
  assert.equal(body.checks.redis.ready, true);
  assert.equal(body.checks.minio.ready, true);
  for (const key of ["active", "failed", "stale", "retrying", "deadLettered"] as const) {
    assert.equal(typeof body.jobs[key], "number");
    assert.ok(body.jobs[key] >= 0, `${key} must be a non-negative count`);
  }
  assert.ok(body.jobs.queueBacklog === null || typeof body.jobs.queueBacklog === "number");

  // Never a credential, connection string, or raw Job input/state anywhere
  // in the response — the whole point of this being counts-only.
  const serialized = JSON.stringify(body);
  for (const forbidden of ["password", "secret", "token", "DATABASE_URL", "REDIS_", "MINIO_SECRET", "://"]) {
    assert.equal(serialized.includes(forbidden), false, `response must never contain "${forbidden}"`);
  }
});
