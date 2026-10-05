import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";

import { DatasetMemberRole, UserRole } from "@internal/db";

import { hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { hasIntegrationDatabase } from "../auth-ownership/helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && hasIntegrationDatabase;
const port = 3126;
const base = `http://127.0.0.1:${port}`;
const password = "discussion-http-password";
const marker = `${Date.now()}-${randomBytes(4).toString("hex")}`;
let server: ChildProcess | undefined;
const ids = { owner: "", member: "", outsider: "", dataset: "", asset: "" };
const cookies = { owner: "", member: "", outsider: "" };

function session(response: Response) {
  const token = /^fieldframe_session=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(token);
  return `fieldframe_session=${token}`;
}

async function waitForServer() {
  for (let index = 0; index < 60; index += 1) {
    try {
      if ((await fetch(`${base}/api/auth/me`)).status < 500) return;
    } catch {
      // The Next server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Discussion HTTP server did not start.");
}

async function login(email: string) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (response.status !== 200) throw new Error(`Login failed (${response.status}): ${await response.text()}`);
  return session(response);
}

before(async () => {
  if (!enabled) return;
  const passwordHash = await hashPassword(password);
  const users = await Promise.all(["owner", "member", "outsider"].map((name) => db.user.create({
    data: { email: `${name}-discussion-${marker}@test.invalid`, passwordHash, role: name === "owner" ? UserRole.MANAGER : UserRole.LABELER },
    select: { id: true, email: true },
  })));
  [ids.owner, ids.member, ids.outsider] = users.map((user) => user.id);
  ids.dataset = (await db.dataset.create({ data: { ownerId: ids.owner, name: `discussion-${marker}` }, select: { id: true } })).id;
  await db.datasetMember.create({ data: { datasetId: ids.dataset, userId: ids.member, role: DatasetMemberRole.LABELER } });
  ids.asset = (await db.asset.create({ data: { datasetId: ids.dataset, modality: "IMAGE", filename: "discussion.png", mimeType: "image/png", sourceFingerprint: marker }, select: { id: true } })).id;
  server = spawn("node_modules/.bin/next", ["start", "--port", String(port)], { cwd: process.cwd(), env: { ...process.env }, stdio: "ignore" });
  await waitForServer();
  [cookies.owner, cookies.member, cookies.outsider] = await Promise.all(users.map((user) => login(user.email)));
});

after(async () => {
  if (server?.exitCode === null) await new Promise<void>((resolve) => { server?.once("exit", resolve); server?.kill("SIGTERM"); });
  if (ids.dataset) await db.dataset.deleteMany({ where: { id: ids.dataset } });
  await db.user.deleteMany({ where: { id: { in: [ids.owner, ids.member, ids.outsider].filter(Boolean) } } });
});

test("discussion HTTP reads, commands, ownership, and hidden scope", { skip: !enabled }, async () => {
  const path = `/api/datasets/${ids.dataset}/assets/${ids.asset}/comments`;
  const hidden = await fetch(`${base}${path}`, { headers: { Cookie: cookies.outsider } });
  assert.equal(hidden.status, 404);
  const created = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", Cookie: cookies.member }, body: JSON.stringify({ body: "root" }) });
  assert.equal(created.status, 201);
  const rootId = ((await created.json()) as { data: { id: string } }).data.id;
  const reply = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", Cookie: cookies.owner }, body: JSON.stringify({ body: "reply", parentId: rootId }) });
  assert.equal(reply.status, 201);
  const replyId = ((await reply.json()) as { data: { id: string } }).data.id;
  const tooDeep = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", Cookie: cookies.member }, body: JSON.stringify({ body: "invalid depth", parentId: replyId }) });
  assert.equal(tooDeep.status, 409);
  const moderated = await fetch(`${base}/api/comments/${rootId}`, { method: "PATCH", headers: { "content-type": "application/json", Cookie: cookies.owner }, body: JSON.stringify({ body: "moderated by owner" }) });
  assert.equal(moderated.status, 200);
  const read = await fetch(`${base}${path}`, { headers: { Cookie: cookies.member } });
  assert.equal(read.status, 200);
  assert.equal(((await read.json()) as { data: { items: unknown[] } }).data.items.length, 1);
  const forbidden = await fetch(`${base}/api/comments/${rootId}`, { method: "PATCH", headers: { "content-type": "application/json", Cookie: cookies.outsider }, body: JSON.stringify({ body: "not allowed" }) });
  assert.equal(forbidden.status, 404);
});
