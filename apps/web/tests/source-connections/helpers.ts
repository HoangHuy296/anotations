import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { UserRole } from "@internal/db";
import { createQueueTransport } from "@annotationplatform/queue";

import { hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { getDirectUploadProviders } from "@/lib/providers";

export const sourceConnectionHttpEnabled =
  process.env.SOURCE_CONNECTION_INTEGRATION_TESTS === "1" &&
  Boolean(process.env.SOURCE_CONNECTION_HTTP_BASE_URL) &&
  Boolean(process.env.SOURCE_CONNECTION_GITEA_BASE_URL) &&
  Boolean(process.env.SOURCE_CONNECTION_GITEA_TOKEN);

export const sourceConnectionHttpSkipReason =
  "source-connection HTTP integration skipped: set SOURCE_CONNECTION_INTEGRATION_TESTS=1 with controlled Compose HTTP/Gitea test settings";

const baseUrl = process.env.SOURCE_CONNECTION_HTTP_BASE_URL ?? "";
const password = randomBytes(24).toString("base64url");

export function uniqueTestEmail(role: string) {
  return `source-${role}-${Date.now()}-${randomBytes(6).toString("hex")}@test.invalid`;
}

function sessionCookie(response: Response) {
  const match = /^fieldframe_session=([^;]+)/i.exec(response.headers.get("set-cookie") ?? "");
  assert.ok(match?.[1], "normal login must issue an opaque session cookie");
  return `fieldframe_session=${match[1]}`;
}

export async function signupAndLogin(role: "MANAGER" | "LABELER" | "REVIEWER" = "MANAGER") {
  const email = uniqueTestEmail(role.toLowerCase());
  const signup = await fetch(`${baseUrl}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name: "Source integration", role }),
  });
  assert.equal(signup.status, 201);
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(login.status, 200);
  return { email, cookie: sessionCookie(login) };
}

/** Admin cannot self-register; it is seeded only for an HTTP login fixture. */
export async function createAdminAndLogin() {
  const email = uniqueTestEmail("admin");
  const user = await db.user.create({
    data: { email, role: UserRole.ADMIN, passwordHash: await hashPassword(password) },
    select: { id: true },
  });
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(login.status, 200);
  return { userId: user.id, email, cookie: sessionCookie(login) };
}

export async function businessSnapshot() {
  const [connections, jobs, events] = await Promise.all([
    db.sourceConnection.count(),
    db.job.count(),
    db.jobEvent.count(),
  ]);
  return { connections, jobs, events };
}

export function assertNoBusinessWrite(before: Awaited<ReturnType<typeof businessSnapshot>>, after: Awaited<ReturnType<typeof businessSnapshot>>) {
  assert.deepEqual(after, before, "denied source request must not write SourceConnection, Job, or JobEvent");
}

/** Test-only controlled-store snapshot; it does not inspect unrelated queues or objects. */
export async function transportAndStorageSnapshot() {
  const { config, minio } = getDirectUploadProviders();
  const prefix = "phase013-test/";
  const objects: string[] = [];
  for await (const item of minio.listObjectsV2(config.MINIO_BUCKET, prefix, true)) {
    if (item.name) objects.push(item.name);
  }
  const queue = createQueueTransport({
    host: process.env.REDIS_HOST ?? "redis",
    port: Number(process.env.REDIS_PORT ?? "6379"),
    password: process.env.REDIS_PASSWORD ?? "",
    db: Number(process.env.REDIS_DB ?? "15"),
    prefix: process.env.BULLMQ_PREFIX ?? "fieldframe-phase013-test",
    failFast: true,
  });
  try {
    const counts = await queue.getJobCounts("wait", "active", "delayed", "completed", "failed");
    return { objects: objects.sort(), queue: counts };
  } finally {
    await queue.close();
  }
}

export function assertNoTransportOrStorageWrite(
  before: Awaited<ReturnType<typeof transportAndStorageSnapshot>>,
  after: Awaited<ReturnType<typeof transportAndStorageSnapshot>>,
) {
  assert.deepEqual(after, before, "denied source request must not write the isolated queue or Phase 013 MinIO prefix");
}

export function assertNoSourceSecret(value: unknown, sentinels: readonly string[] = []) {
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    "tokenEncrypted",
    "refreshTokenEncrypted",
    "SOURCE_CONNECTION_ENCRYPTION_KEY",
    "DATABASE_URL",
    "REDIS_PASSWORD",
    "stack",
    ...sentinels,
  ]) assert.equal(serialized.includes(forbidden), false, `response leaked ${forbidden}`);
}

export function controlledGiteaInput(token = process.env.SOURCE_CONNECTION_GITEA_TOKEN ?? "") {
  return {
    provider: "GITEA" as const,
    name: "Controlled Gitea",
    baseUrl: process.env.SOURCE_CONNECTION_GITEA_BASE_URL ?? "",
    token,
  };
}

export function request(path: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, init);
}
