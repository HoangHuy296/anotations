import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";

import { NotificationType, UserRole } from "@internal/db";

import { hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { hasIntegrationDatabase } from "../auth-ownership/helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && hasIntegrationDatabase;
// A per-process high port prevents a previously interrupted integration run
// from being mistaken for this test's production server.
const port = 32_000 + (randomBytes(2).readUInt16BE(0) % 2_000);
const base = `http://127.0.0.1:${port}`;
const password = "notification-http-password";
const marker = randomBytes(4).toString("hex");
let server: ChildProcess | undefined;
let serverExited = false;
let serverReportedReady = false;
let serverDiagnostic = "";
const ids = { owner: "", recipient: "", dataset: "", notification: "" };
const cookies = { owner: "", recipient: "" };

function session(response: Response) {
  const token = /^fieldframe_session=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(token, `login did not create a session (${response.status})`);
  return `fieldframe_session=${token}`;
}

async function waitForReady() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (serverExited) throw new Error("notification HTTP server exited before readiness");
    try {
      const response = await fetch(`${base}/api/auth/me`);
      if (serverReportedReady && (response.status === 401 || response.status === 200)) return;
    } catch {
      // The server has not bound the isolated port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("notification HTTP server did not reach the authenticated readiness endpoint");
}

async function login(email: string) {
  const response = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  return response;
}

before(async () => {
  if (!enabled) return;
  const passwordHash = await hashPassword(password);
  const users = await Promise.all(["owner", "recipient"].map((name) => db.user.create({ data: { email: `${name}-${marker}@test.invalid`, passwordHash, role: UserRole.LABELER }, select: { id: true, email: true } })));
  [ids.owner, ids.recipient] = users.map((user) => user.id);
  ids.dataset = (await db.dataset.create({ data: { ownerId: ids.owner, name: `notification-${marker}` }, select: { id: true } })).id;
  ids.notification = (await db.notification.create({ data: { userId: ids.recipient, actorId: ids.owner, type: NotificationType.MENTIONED, datasetId: ids.dataset, title: "Mention", body: "Safe", dedupeKey: `http-${marker}` }, select: { id: true } })).id;
  const child = spawn("node_modules/.bin/next", ["start", "--port", String(port)], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"] });
  server = child;
  const capture = (chunk: Buffer) => {
    const value = chunk.toString();
    if (/\bready\b/i.test(value)) serverReportedReady = true;
    serverDiagnostic = `${serverDiagnostic}${value}`.slice(-2_000);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  child.once("exit", () => { serverExited = true; });
  await waitForReady();
  const responses = await Promise.all(users.map((user) => login(user.email)));
  const failed = responses.find((response) => !response.ok);
  if (failed) {
    const sessions = await db.authSession.count({ where: { userId: users[responses.indexOf(failed)]!.id } });
    throw new Error(`login failed (${failed.status}); persistedAuthSessions=${sessions}; ${serverDiagnostic.replace(/postgres(?:ql)?:\/\/[^\s]+/g, "[redacted]").slice(-500)}`);
  }
  [cookies.owner, cookies.recipient] = responses.map(session) as [string, string];
});

after(async () => {
  const child = server;
  if (child?.exitCode === null) await new Promise<void>((resolve) => { child.once("exit", resolve); child.kill("SIGTERM"); });
  if (ids.dataset) await db.dataset.deleteMany({ where: { id: ids.dataset } });
  await db.user.deleteMany({ where: { id: { in: [ids.owner, ids.recipient].filter(Boolean) } } });
});

test("notification HTTP list/read routes are recipient-scoped, redacted, and idempotent", { skip: !enabled }, async () => {
  assert.equal((await fetch(`${base}/api/notifications`)).status, 401);
  const list = await fetch(`${base}/api/notifications?limit=1`, { headers: { Cookie: cookies.recipient } });
  assert.equal(list.status, 200);
  const page = await list.json() as { data: { unreadCount: number; items: Array<{ id: string; datasetId?: string; outbox?: unknown }> } };
  assert.equal(page.data.unreadCount, 1);
  assert.equal(page.data.items[0]?.id, ids.notification);
  assert.equal("outbox" in page.data.items[0]!, false, "safe DTO excludes internal delivery state");
  assert.equal((await fetch(`${base}/api/notifications?limit=999`, { headers: { Cookie: cookies.recipient } })).status, 400);
  assert.equal((await fetch(`${base}/api/notifications/${ids.notification}/read`, { method: "POST", headers: { Cookie: cookies.owner } })).status, 404);
  assert.equal((await fetch(`${base}/api/notifications/${ids.notification}/read`, { method: "POST", headers: { Cookie: cookies.recipient } })).status, 200);
  assert.equal((await fetch(`${base}/api/notifications/${ids.notification}/read`, { method: "POST", headers: { Cookie: cookies.recipient } })).status, 200);
  assert.equal((await fetch(`${base}/api/notifications/read-all`, { method: "POST", headers: { Cookie: cookies.recipient } })).status, 200);
});
