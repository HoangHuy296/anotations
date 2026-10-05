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
const port = 3_124;
const baseUrl = `http://127.0.0.1:${port}`;
const password = "collaboration-membership-http-password";
const suffix = `${Date.now()}-${randomBytes(5).toString("hex")}`;
let server: ChildProcess | undefined;
let ownerId = "";
let targetId = "";
let outsiderId = "";
let ownerCookie = "";
let targetCookie = "";
let outsiderCookie = "";
let datasetId = "";

function cookie(response: Response) {
  const value = /^fieldframe_session=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(value); return `fieldframe_session=${value}`;
}
async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await fetch(`${baseUrl}/api/auth/me`)).status === 401) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Membership HTTP test server did not start.");
}
async function login(email: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  assert.equal(response.status, 200); return cookie(response);
}
async function api(path: string, options: RequestInit = {}) { return fetch(`${baseUrl}${path}`, options); }

before(async () => {
  if (!enabled) return;
  const passwordHash = await hashPassword(password);
  const [owner, target, outsider] = await Promise.all([
    db.user.create({ data: { email: `collab-owner-${suffix}@test.invalid`, passwordHash, role: UserRole.MANAGER }, select: { id: true, email: true } }),
    db.user.create({ data: { email: `collab-target-${suffix}@test.invalid`, passwordHash, role: UserRole.LABELER }, select: { id: true, email: true } }),
    db.user.create({ data: { email: `collab-outsider-${suffix}@test.invalid`, passwordHash, role: UserRole.LABELER }, select: { id: true, email: true } }),
  ]);
  ownerId = owner.id; targetId = target.id; outsiderId = outsider.id;
  datasetId = (await db.dataset.create({ data: { ownerId, name: `collab-http-${suffix}` }, select: { id: true } })).id;
  server = spawn("node_modules/.bin/next", ["start", "--port", String(port)], { cwd: process.cwd(), env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" }, stdio: "ignore" });
  await waitForServer();
  [ownerCookie, targetCookie, outsiderCookie] = await Promise.all([login(owner.email), login(target.email), login(outsider.email)]);
});
after(async () => {
  if (server?.exitCode === null) await new Promise<void>((resolve) => { server?.once("exit", resolve); server?.kill("SIGTERM"); });
  if (datasetId) await db.dataset.deleteMany({ where: { id: datasetId } });
  await db.user.deleteMany({ where: { id: { in: [ownerId, targetId, outsiderId].filter(Boolean) } } });
});

test("member/invitation HTTP commands enforce authorization, conceal unrelated scope, and expose idempotent lifecycle results", { skip: !enabled }, async () => {
  const body = { inviteeUserId: targetId, role: DatasetMemberRole.LABELER };
  const concealed = await api(`/api/datasets/${datasetId}/invitations`, { method: "POST", headers: { "content-type": "application/json", Cookie: outsiderCookie }, body: JSON.stringify(body) });
  assert.equal(concealed.status, 404);
  const invited = await api(`/api/datasets/${datasetId}/invitations`, { method: "POST", headers: { "content-type": "application/json", Cookie: ownerCookie }, body: JSON.stringify(body) });
  assert.equal(invited.status, 201);
  const invitation = await invited.json() as { data: { id: string } };
  const duplicate = await api(`/api/datasets/${datasetId}/invitations`, { method: "POST", headers: { "content-type": "application/json", Cookie: ownerCookie }, body: JSON.stringify(body) });
  assert.equal(duplicate.status, 200);
  const accepted = await api(`/api/invitations/${invitation.data.id}/accept`, { method: "POST", headers: { Cookie: targetCookie } });
  assert.equal(accepted.status, 201);
  const replay = await api(`/api/invitations/${invitation.data.id}/accept`, { method: "POST", headers: { Cookie: targetCookie } });
  assert.equal(replay.status, 200);
  const members = await api(`/api/datasets/${datasetId}/members`, { headers: { Cookie: targetCookie } });
  assert.equal(members.status, 200);
  const targetCannotManage = await api(`/api/datasets/${datasetId}/members/${targetId}`, { method: "PATCH", headers: { "content-type": "application/json", Cookie: targetCookie }, body: JSON.stringify({ role: DatasetMemberRole.REVIEWER }) });
  assert.equal(targetCannotManage.status, 403);
  const unrelatedInvite = await api(`/api/invitations/${invitation.data.id}/decline`, { method: "POST", headers: { Cookie: outsiderCookie } });
  assert.equal(unrelatedInvite.status, 404);
  assert.equal(await db.datasetMember.count({ where: { datasetId, userId: targetId } }), 1);
  const removed = await api(`/api/datasets/${datasetId}/members/${targetId}`, { method: "DELETE", headers: { Cookie: ownerCookie } });
  assert.equal(removed.status, 200);
  const removedRead = await api(`/api/datasets/${datasetId}/members`, { headers: { Cookie: targetCookie } });
  assert.equal(removedRead.status, 404, "removed members lose protected REST access on their next request");
});
