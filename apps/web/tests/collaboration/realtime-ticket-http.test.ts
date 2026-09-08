import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";

import { UserRole } from "@internal/db";
import { hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { hasIntegrationDatabase } from "../auth-ownership/helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && hasIntegrationDatabase;
const port = 35_000 + (randomBytes(2).readUInt16BE(0) % 1_000);
const base = `http://127.0.0.1:${port}`;
const marker = randomBytes(5).toString("hex");
const password = "realtime-ticket-http-password";
let server: ChildProcess | undefined;
let ready = false;
let userId = "";
let datasetId = "";
let cookie = "";

async function waitForReady() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if (ready && (await fetch(`${base}/api/auth/me`)).status === 401) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("realtime ticket production server did not become ready");
}

before(async () => {
  if (!enabled) return;
  const user = await db.user.create({ data: { email: `ticket-${marker}@test.invalid`, passwordHash: await hashPassword(password), role: UserRole.MANAGER }, select: { id: true, email: true } });
  userId = user.id;
  datasetId = (await db.dataset.create({ data: { ownerId: user.id, name: `ticket-${marker}` }, select: { id: true } })).id;
  server = spawn("node_modules/.bin/next", ["start", "--port", String(port)], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, NODE_ENV: "production", REALTIME_TICKET_SECRET: "realtime-ticket-http-secret-which-is-long-enough" }, stdio: ["ignore", "pipe", "pipe"] });
  const capture = (chunk: Buffer) => { if (/\bready\b/i.test(chunk.toString())) ready = true; };
  server.stdout?.on("data", capture); server.stderr?.on("data", capture);
  await waitForReady();
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: user.email, password }) });
  const token = /^fieldframe_session=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(token); cookie = `fieldframe_session=${token}`;
});

after(async () => {
  if (server?.exitCode === null) await new Promise<void>((resolve) => { server?.once("exit", resolve); server?.kill("SIGTERM"); });
  if (datasetId) await db.dataset.deleteMany({ where: { id: datasetId } });
  if (userId) await db.user.deleteMany({ where: { id: userId } });
});

test("realtime ticket endpoint authorizes scopes and conceals denied datasets", { skip: !enabled }, async () => {
  assert.equal((await fetch(`${base}/api/realtime/ticket`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ datasetIds: [datasetId] }) })).status, 401);
  assert.equal((await fetch(`${base}/api/realtime/ticket`, { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify({ datasetIds: [] }) })).status, 400);
  const granted = await fetch(`${base}/api/realtime/ticket`, { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify({ datasetIds: [datasetId] }) });
  assert.equal(granted.status, 200);
  const body = await granted.json() as { data: { token: string; expiresAt: string; databaseUrl?: unknown } };
  assert.ok(body.data.token.length > 20);
  assert.ok(Number.isFinite(Date.parse(body.data.expiresAt)));
  assert.equal("databaseUrl" in body.data, false);
  assert.equal((await fetch(`${base}/api/realtime/ticket`, { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify({ datasetIds: ["ckaaaaaaaaaaaaaaaaaaaaaaaa"] }) })).status, 404);
});
