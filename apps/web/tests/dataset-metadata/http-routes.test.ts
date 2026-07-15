import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import test, { after, before } from "node:test";

import { AssetStatus, Modality, UserRole } from "@internal/db";

import { hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { hasIntegrationDatabase } from "../auth-ownership/helpers";

const port = 3_105;
const baseUrl = `http://127.0.0.1:${port}`;
const password = "phase-five-http-password";
const suffix = `${Date.now()}-${randomBytes(5).toString("hex")}`;
const managerEmail = `manager-http-${suffix}@phase005.test`;
const outsiderEmail = `outsider-http-${suffix}@phase005.test`;
let server: ChildProcess | undefined;
let managerId = "";
let managerCookie = "";
let outsiderCookie = "";
let datasetId = "";

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/auth/me`);
      if (response.status === 401) return;
    } catch {
      // The development server has not bound its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Next.js test server did not start.");
}

function sessionCookie(response: Response) {
  const value = response.headers.get("set-cookie") ?? "";
  const token = /^fieldframe_session=([^;]+)/.exec(value)?.[1];
  assert.ok(token, "login response must set an opaque session cookie");
  return `fieldframe_session=${token}`;
}

async function login(email: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  assert.equal(response.status, 200);
  return sessionCookie(response);
}

before(async () => {
  if (!hasIntegrationDatabase) return;
  const passwordHash = await hashPassword(password);
  const [manager] = await Promise.all([
    db.user.create({ data: { email: managerEmail, passwordHash, role: UserRole.MANAGER }, select: { id: true } }),
    db.user.create({ data: { email: outsiderEmail, passwordHash, role: UserRole.LABELER }, select: { id: true } }),
  ]);
  managerId = manager.id;
  server = spawn("node_modules/.bin/next", ["start", "--port", String(port)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PRISMA_QUERY_ENGINE_LIBRARY: resolve(process.cwd(), "../../lib/generated/prisma/libquery_engine-debian-openssl-3.0.x.so.node"),
    },
    stdio: "ignore",
  });
  await waitForServer();
  managerCookie = await login(managerEmail);
  outsiderCookie = await login(outsiderEmail);
});

after(async () => {
  const runningServer = server;
  if (runningServer && runningServer.exitCode === null) {
    await new Promise<void>((resolve) => {
      runningServer.once("exit", () => resolve());
      runningServer.kill("SIGTERM");
    });
  }
  await db.user.deleteMany({ where: { email: { in: [managerEmail, outsiderEmail] } } });
});

test("Dataset CRUD, archive, and server-derived ownership work through HTTP", { skip: !hasIntegrationDatabase }, async () => {
  const created = await fetch(`${baseUrl}/api/datasets`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: managerCookie }, body: JSON.stringify({ name: "HTTP multimodal dataset", type: "MULTI_MODAL", primaryModality: null, ownerId: "forged" }) });
  assert.equal(created.status, 201);
  const dataset = await created.json() as { data: { id: string; ownerId?: string; primaryModality: string | null } };
  datasetId = dataset.data.id;
  assert.equal(dataset.data.primaryModality, null);
  assert.equal("ownerId" in dataset.data, false);
  assert.equal((await db.dataset.findUnique({ where: { id: datasetId }, select: { ownerId: true } }))?.ownerId, managerId);

  const updated = await fetch(`${baseUrl}/api/datasets/${datasetId}`, { method: "PATCH", headers: { "Content-Type": "application/json", Cookie: managerCookie }, body: JSON.stringify({ description: "safe metadata" }) });
  assert.equal(updated.status, 200);
  const archived = await fetch(`${baseUrl}/api/datasets/${datasetId}`, { method: "DELETE", headers: { Cookie: managerCookie } });
  assert.equal(archived.status, 200);
  assert.ok((await db.dataset.findUnique({ where: { id: datasetId }, select: { archivedAt: true } }))?.archivedAt);
});

test("Labels reject duplicate normalized names and outsiders have no side effect", { skip: !hasIntegrationDatabase }, async () => {
  const active = await db.dataset.create({ data: { ownerId: managerId, name: `HTTP labels ${suffix}` }, select: { id: true } });
  const body = { name: "Traffic Sign", color: "#0EA5E9" };
  const first = await fetch(`${baseUrl}/api/datasets/${active.id}/labels`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: managerCookie }, body: JSON.stringify(body) });
  assert.equal(first.status, 201);
  const duplicate = await fetch(`${baseUrl}/api/datasets/${active.id}/labels`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: managerCookie }, body: JSON.stringify({ ...body, name: "  traffic sign  " }) });
  assert.equal(duplicate.status, 409);
  const before = await db.label.count({ where: { datasetId: active.id } });
  const denied = await fetch(`${baseUrl}/api/datasets/${active.id}/labels`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: outsiderCookie }, body: JSON.stringify({ name: "Hidden", color: "#111111" }) });
  assert.equal(denied.status, 404);
  assert.equal(await db.label.count({ where: { datasetId: active.id } }), before);
});

test("Asset pagination/filter is Dataset-scoped and returns only safe metadata", { skip: !hasIntegrationDatabase }, async () => {
  const active = await db.dataset.create({ data: { ownerId: managerId, name: `HTTP assets ${suffix}` }, select: { id: true } });
  await Promise.all(["road-a.png", "road-b.png"].map((filename) => db.asset.create({ data: { datasetId: active.id, modality: Modality.IMAGE, filename, mimeType: "image/png", sourceFingerprint: `http-${suffix}-${filename}`, status: AssetStatus.NEW, sourcePath: "private/path.png" } })));
  const response = await fetch(`${baseUrl}/api/datasets/${active.id}/assets?limit=1&status=NEW&q=road`, { headers: { Cookie: managerCookie } });
  assert.equal(response.status, 200);
  const body = await response.json() as { data: { items: Array<Record<string, unknown>>; page: { limit: number; hasNextPage: boolean } } };
  assert.equal(body.data.items.length, 1);
  assert.equal(body.data.page.limit, 1);
  assert.equal(body.data.page.hasNextPage, true);
  assert.equal("sourcePath" in body.data.items[0], false);
  assert.equal("storageKey" in body.data.items[0], false);
  const denied = await fetch(`${baseUrl}/api/datasets/${active.id}/assets`, { headers: { Cookie: outsiderCookie } });
  assert.equal(denied.status, 404);
});
