import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { DatasetMemberRole, UserRole } from "@internal/db";

import { hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { cleanupWorkspaceFixture, createImageAsset, createWorkspaceDataset, createWorkspaceUser } from "../workspace/helpers";

const enabled = process.env.WORKFLOW_HTTP_TESTS === "1";
const baseUrl = process.env.WORKFLOW_HTTP_BASE_URL ?? "http://127.0.0.1:3000";
const password = "workflow-http-test-password";
let owner: Awaited<ReturnType<typeof createWorkspaceUser>>;
let labeler: Awaited<ReturnType<typeof createWorkspaceUser>>;
let reviewer: Awaited<ReturnType<typeof createWorkspaceUser>>;
let outsider: Awaited<ReturnType<typeof createWorkspaceUser>>;
let datasetId = "";
let assetId = "";
let labelerCookie = "";
let reviewerCookie = "";
let outsiderCookie = "";

function cookie(response: Response) {
  const token = /^fieldframe_session=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(token, "login must return a session cookie");
  return `fieldframe_session=${token}`;
}
async function login(email: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  assert.equal(response.status, 200);
  return cookie(response);
}
async function request(path: string, session?: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(session ? { Cookie: session } : {}), ...(init?.headers ?? {}) } });
}

before(async () => {
  if (!enabled) return;
  owner = await createWorkspaceUser(UserRole.MANAGER);
  labeler = await createWorkspaceUser(UserRole.LABELER);
  reviewer = await createWorkspaceUser(UserRole.REVIEWER);
  outsider = await createWorkspaceUser(UserRole.LABELER);
  const passwordHash = await hashPassword(password);
  await Promise.all([labeler, reviewer, outsider].map((user) => db.user.update({ where: { id: user.id }, data: { passwordHash } })));
  const dataset = await createWorkspaceDataset(owner.id);
  datasetId = dataset.id;
  await db.datasetMember.createMany({ data: [{ datasetId, userId: labeler.id, role: DatasetMemberRole.LABELER }, { datasetId, userId: reviewer.id, role: DatasetMemberRole.REVIEWER }] });
  assetId = (await createImageAsset(datasetId)).id;
  [labelerCookie, reviewerCookie, outsiderCookie] = await Promise.all([login(labeler.email), login(reviewer.email), login(outsider.email)]);
});
after(async () => { if (enabled) await cleanupWorkspaceFixture([owner.id, labeler.id, reviewer.id, outsider.id], [datasetId]); });

test("workflow HTTP contract validates auth, input, transitions, and stale decisions", { skip: enabled ? false : "Set WORKFLOW_HTTP_TESTS=1 with PostgreSQL and the web service." }, async () => {
  const path = `/api/datasets/${datasetId}/assets/${assetId}/workflow`;
  assert.equal((await request(path)).status, 401);
  assert.equal((await request(path, labelerCookie, { method: "POST", body: JSON.stringify({ action: "REJECT", expectedRevision: 1, feedback: "" }) })).status, 400);
  assert.equal((await request(path, reviewerCookie, { method: "POST", body: JSON.stringify({ action: "START", expectedRevision: 1 }) })).status, 403);
  assert.equal((await request(path, reviewerCookie, { method: "POST", body: JSON.stringify({ action: "APPROVE", expectedRevision: 1 }) })).status, 409);
  const started = await request(path, labelerCookie, { method: "POST", body: JSON.stringify({ action: "START", expectedRevision: 1 }) });
  assert.equal(started.status, 200);
  const startedBody = await started.json() as { data: { asset: { revision: number } } };
  const submitted = await request(path, labelerCookie, { method: "POST", body: JSON.stringify({ action: "SUBMIT", expectedRevision: startedBody.data.asset.revision }) });
  assert.equal(submitted.status, 200);
  const submittedBody = await submitted.json() as { data: { asset: { revision: number } } };
  const stale = await request(path, reviewerCookie, { method: "POST", body: JSON.stringify({ action: "APPROVE", expectedRevision: submittedBody.data.asset.revision - 1 }) });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json() as { error: { code: string } }).error.code, "STALE_REVISION");
  assert.equal((await request(path, outsiderCookie)).status, 404);
});
