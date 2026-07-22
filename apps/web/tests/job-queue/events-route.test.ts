import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import test, { after, before } from "node:test";

import { DatasetMemberRole, JobEventLevel, JobStatus, JobType, UserRole } from "@internal/db";

import { hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { hasQueueIntegration, queueIntegrationSkipReason } from "./helpers";

const port = 3_108;
const baseUrl = `http://127.0.0.1:${port}`;
const password = "phase-nine-events-password";
const suffix = `${Date.now()}-${randomBytes(5).toString("hex")}`;
let server: ChildProcess | undefined;
let datasetId = "";
let jobId = "";
let ownerCookie = "";
let outsiderCookie = "";
let userIds: string[] = [];

function cookie(response: Response) {
  const token = /^fieldframe_session=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(token, "login must issue an opaque session cookie");
  return `fieldframe_session=${token}`;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/api/auth/me`)).status === 401) return;
    } catch { /* server is still starting */ }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error("Next.js test server did not start.");
}

async function login(email: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200);
  return cookie(response);
}

before(async () => {
  if (!hasQueueIntegration) return;
  const passwordHash = await hashPassword(password);
  const [owner, member, outsider] = await Promise.all([
    db.user.create({ data: { email: `events-owner-${suffix}@test.local`, passwordHash, role: UserRole.MANAGER }, select: { id: true } }),
    db.user.create({ data: { email: `events-member-${suffix}@test.local`, passwordHash, role: UserRole.REVIEWER }, select: { id: true } }),
    db.user.create({ data: { email: `events-outsider-${suffix}@test.local`, passwordHash, role: UserRole.LABELER }, select: { id: true } }),
  ]);
  userIds = [owner.id, member.id, outsider.id];
  const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `events-${suffix}` }, select: { id: true } });
  datasetId = dataset.id;
  await db.datasetMember.create({ data: { datasetId, userId: member.id, role: DatasetMemberRole.REVIEWER } });
  const job = await db.job.create({ data: { datasetId, createdById: owner.id, type: JobType.EXPORT_DATASET, status: JobStatus.QUEUED }, select: { id: true } });
  jobId = job.id;
  const start = Date.now();
  await db.jobEvent.createMany({ data: [
    { jobId, message: "QUEUE_ENQUEUED", data: { queueName: "secret", queueJobId: "secret" }, createdAt: new Date(start) },
    { jobId, message: "QUEUE_SKIPPED", level: JobEventLevel.WARN, data: { reason: "UNSUPPORTED_TYPE", credential: "secret" }, createdAt: new Date(start + 1_000) },
    { jobId, message: "PRIVATE_INTERNAL_NOTE", data: { token: "must-not-leak" }, createdAt: new Date(start + 2_000) },
  ] });
  server = spawn("node_modules/.bin/next", ["start", "--port", String(port)], {
    cwd: process.cwd(),
    env: { ...process.env, PRISMA_QUERY_ENGINE_LIBRARY: resolve(process.cwd(), "../../lib/generated/prisma/libquery_engine-debian-openssl-3.0.x.so.node") },
    stdio: "ignore",
  });
  await waitForServer();
  [ownerCookie, outsiderCookie] = await Promise.all([
    login(`events-owner-${suffix}@test.local`),
    login(`events-outsider-${suffix}@test.local`),
  ]);
});

after(async () => {
  if (server?.exitCode === null) await new Promise<void>((done) => { server?.once("exit", () => done()); server?.kill("SIGTERM"); });
  if (datasetId) await db.dataset.deleteMany({ where: { id: datasetId } });
  if (userIds.length) await db.user.deleteMany({ where: { id: { in: userIds } } });
});

test("Job events are Dataset-authorized, ordered, cursor-paginated, and redact raw data", { skip: queueIntegrationSkipReason }, async () => {
  const anonymous = await fetch(`${baseUrl}/api/jobs/${jobId}/events`);
  assert.equal(anonymous.status, 401);

  const first = await fetch(`${baseUrl}/api/jobs/${jobId}/events?limit=1`, { headers: { Cookie: ownerCookie } });
  assert.equal(first.status, 200);
  const firstBody = await first.json() as { data: { events: Array<Record<string, unknown>>; nextCursor: string | null } };
  // The newest persisted row is unknown and omitted before public pagination.
  assert.deepEqual(firstBody.data.events.map((event) => event.message), ["QUEUE_SKIPPED"]);
  assert.equal(firstBody.data.events[0]?.reason, "UNSUPPORTED_TYPE");
  assert.ok(firstBody.data.nextCursor);

  const second = await fetch(`${baseUrl}/api/jobs/${jobId}/events?limit=10&cursor=${encodeURIComponent(firstBody.data.nextCursor)}`, { headers: { Cookie: ownerCookie } });
  assert.equal(second.status, 200);
  const secondBody = await second.json() as { data: { events: Array<Record<string, unknown>>; nextCursor: string | null } };
  assert.deepEqual(secondBody.data.events.map((event) => event.message), ["QUEUE_ENQUEUED"]);
  for (const event of secondBody.data.events) {
    assert.equal("data" in event, false);
    assert.equal("queueName" in event, false);
    assert.equal("queueJobId" in event, false);
  }
  assert.equal(JSON.stringify(secondBody).includes("secret"), false);
  assert.equal(JSON.stringify(secondBody).includes("must-not-leak"), false);

  const invalidCursor = await fetch(`${baseUrl}/api/jobs/${jobId}/events?cursor=bad`, { headers: { Cookie: ownerCookie } });
  assert.equal(invalidCursor.status, 400);
  const outsider = await fetch(`${baseUrl}/api/jobs/${jobId}/events`, { headers: { Cookie: outsiderCookie } });
  assert.equal(outsider.status, 404);
});
