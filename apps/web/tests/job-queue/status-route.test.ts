import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import test, { after, before } from "node:test";

import { DatasetMemberRole, JobStatus, JobType, UserRole } from "@internal/db";

import { hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { hasQueueIntegration } from "./helpers";

const port = 3_107;
const baseUrl = `http://127.0.0.1:${port}`;
const password = "phase-seven-status-password";
const suffix = `${Date.now()}-${randomBytes(5).toString("hex")}`;
const ownerEmail = `owner-${suffix}@phase007.test`;
const memberEmail = `member-${suffix}@phase007.test`;
const outsiderEmail = `outsider-${suffix}@phase007.test`;
let server: ChildProcess | undefined;
let ownerCookie = "";
let memberCookie = "";
let outsiderCookie = "";
let jobId = "";
let userIds: string[] = [];
let datasetId = "";

function cookie(response: Response) {
  const value = response.headers.get("set-cookie") ?? "";
  const token = /^fieldframe_session=([^;]+)/.exec(value)?.[1];
  assert.ok(token, "login must issue an opaque session cookie");
  return `fieldframe_session=${token}`;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/api/auth/me`)).status === 401) return;
    } catch { /* Next has not bound its test port yet. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Next.js test server did not start.");
}

async function login(email: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200);
  return cookie(response);
}

before(async () => {
  if (!hasQueueIntegration) return;
  const passwordHash = await hashPassword(password);
  const [owner, member, outsider] = await Promise.all([
    db.user.create({ data: { email: ownerEmail, passwordHash, role: UserRole.MANAGER }, select: { id: true } }),
    db.user.create({ data: { email: memberEmail, passwordHash, role: UserRole.REVIEWER }, select: { id: true } }),
    db.user.create({ data: { email: outsiderEmail, passwordHash, role: UserRole.LABELER }, select: { id: true } }),
  ]);
  userIds = [owner.id, member.id, outsider.id];
  const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `status-${suffix}` }, select: { id: true } });
  datasetId = dataset.id;
  await db.datasetMember.create({ data: { datasetId, userId: member.id, role: DatasetMemberRole.REVIEWER } });
  const job = await db.job.create({ data: {
    datasetId, createdById: owner.id, type: JobType.EXPORT_DATASET, status: JobStatus.QUEUED,
    input: { token: "must-not-leak" }, state: { queue: "must-not-leak" }, summary: { raw: "must-not-leak" }, error: "must-not-leak",
    progress: 3, totalItems: 10, processedItems: 3, successItems: 2, failedItems: 1, skippedItems: 0,
    queueName: "private", queueJobId: "private", enqueuedAt: new Date(),
  }, select: { id: true } });
  jobId = job.id;
  server = spawn("node_modules/.bin/next", ["start", "--port", String(port)], {
    cwd: process.cwd(), env: { ...process.env, PRISMA_QUERY_ENGINE_LIBRARY: resolve(process.cwd(), "../../lib/generated/prisma/libquery_engine-debian-openssl-3.0.x.so.node") }, stdio: "ignore",
  });
  await waitForServer();
  [ownerCookie, memberCookie, outsiderCookie] = await Promise.all([login(ownerEmail), login(memberEmail), login(outsiderEmail)]);
});

after(async () => {
  if (server?.exitCode === null) await new Promise<void>((done) => { server?.once("exit", () => done()); server?.kill("SIGTERM"); });
  if (datasetId) await db.dataset.deleteMany({ where: { id: datasetId } });
  if (userIds.length) await db.user.deleteMany({ where: { id: { in: userIds } } });
});

test("Job status is PostgreSQL-backed, Dataset-authorized, and fully redacted", { skip: !hasQueueIntegration }, async () => {
  const anonymous = await fetch(`${baseUrl}/api/jobs/${jobId}`);
  assert.equal(anonymous.status, 401);
  const owner = await fetch(`${baseUrl}/api/jobs/${jobId}`, { headers: { Cookie: ownerCookie } });
  assert.equal(owner.status, 200);
  const body = await owner.json() as { data: Record<string, unknown> };
  assert.equal(body.data.id, jobId);
  assert.equal(body.data.datasetId, datasetId);
  assert.equal(body.data.successCount, 2);
  assert.equal(body.data.failedCount, 1);
  assert.equal(body.data.summary, null);
  for (const field of ["input", "state", "result", "error", "queueName", "queueJobId", "enqueuedAt", "raw", "events"]) assert.equal(field in body.data, false);
  assert.equal(JSON.stringify(body).includes("must-not-leak"), false);
  assert.equal((await fetch(`${baseUrl}/api/jobs/${jobId}`, { headers: { Cookie: memberCookie } })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/jobs/${jobId}`, { headers: { Cookie: outsiderCookie } })).status, 404);
});
