import assert from "node:assert/strict";
import test, { after } from "node:test";

import { db } from "@/lib/db";
import {
  assertNoSourceSecret,
  request,
  signupAndLogin,
  sourceConnectionHttpEnabled,
  sourceConnectionHttpSkipReason,
} from "./helpers";

const users: string[] = [];
after(async () => { await db.user.deleteMany({ where: { id: { in: users } } }); });

test("normal production web maps only configured public Gitea root to its internal endpoint", {
  skip: sourceConnectionHttpEnabled ? false : sourceConnectionHttpSkipReason,
}, async () => {
  const actor = await signupAndLogin("MANAGER");
  const user = await db.user.findUniqueOrThrow({ where: { email: actor.email }, select: { id: true } });
  users.push(user.id);
  const before = await Promise.all([db.dataset.count(), db.sourceConnection.count(), db.job.count()]);
  const response = await request("/api/source-import-preflight", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: actor.cookie },
    body: JSON.stringify({
      provider: "GITEA",
      datasetName: "production mapping preview",
      credentialMode: "PUBLIC",
      serverUrl: process.env.SOURCE_CONNECTION_GITEA_BASE_URL,
      repository: { owner: "annotation-admin", repo: "ImageDataset", ref: "main", expectedVisibility: "PUBLIC" },
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.repository.fullName, "annotation-admin/ImageDataset");
  assert.equal(body.data.repository.ref, "main");
  assert.equal(typeof body.data.repository.revision, "string");
  assert.ok(body.data.assetPreview);
  assert.equal(typeof body.data.assetPreview.detectedAssetCount, "number");
  assert.equal(typeof body.data.assetPreview.detectedBytes, "number");
  assertNoSourceSecret(body);
  assert.deepEqual(await Promise.all([db.dataset.count(), db.sourceConnection.count(), db.job.count()]), before);

  const pat = process.env.SOURCE_CONNECTION_GITEA_TOKEN!;
  const oneTimePreview = await request("/api/source-import-preflight", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: actor.cookie },
    body: JSON.stringify({
      provider: "GITEA",
      datasetName: "production one-time preview",
      credentialMode: "ONE_TIME_PAT",
      serverUrl: process.env.SOURCE_CONNECTION_GITEA_BASE_URL,
      personalAccessToken: pat,
      saveAsSourceConnection: true,
      connectionName: "production preview only",
      repository: { owner: "annotation-admin", repo: "ImageDataset", ref: "main", expectedVisibility: "PUBLIC" },
    }),
  });
  const oneTimeBody = await oneTimePreview.json();
  assert.equal(oneTimePreview.status, 200);
  assert.equal(oneTimeBody.data.repository.fullName, "annotation-admin/ImageDataset");
  assert.ok(oneTimeBody.data.assetPreview);
  assertNoSourceSecret(oneTimeBody, [pat]);
  assert.deepEqual(await Promise.all([db.dataset.count(), db.sourceConnection.count(), db.job.count()]), before);

  const blockedStart = await request("/api/datasets/from-repository", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: actor.cookie },
    body: JSON.stringify({
      provider: "GITEA",
      datasetName: "visibility mismatch must not persist",
      credentialMode: "PUBLIC",
      serverUrl: process.env.SOURCE_CONNECTION_GITEA_BASE_URL,
      idempotencyKey: "phase015-production-mapping-visibility-mismatch",
      repository: { owner: "annotation-admin", repo: "ImageDataset", ref: "main", expectedVisibility: "PRIVATE" },
    }),
  });
  const blockedBody = await blockedStart.json();
  assert.equal(blockedStart.status, 422);
  assert.equal(blockedBody.error.code, "INVALID_REQUEST");
  assertNoSourceSecret(blockedBody);
  assert.deepEqual(await Promise.all([db.dataset.count(), db.sourceConnection.count(), db.job.count()]), before);
});
