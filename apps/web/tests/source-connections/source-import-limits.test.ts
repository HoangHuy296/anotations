import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after } from "node:test";

import { db } from "@/lib/db";
import {
  assertNoSourceSecret,
  assertNoTransportOrStorageWrite,
  request,
  signupAndLogin,
  sourceConnectionHttpEnabled,
  sourceConnectionHttpSkipReason,
  transportAndStorageSnapshot,
} from "./helpers";

const users: string[] = [];
after(async () => {
  await db.dataset.deleteMany({ where: { ownerId: { in: users } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
});

function publicSourceBody(datasetId: string, overrides: Record<string, unknown> = {}) {
  return {
    datasetId,
    sourceConnectionId: null,
    repository: {
      provider: "GITEA",
      owner: "public-owner",
      repo: "public-repository",
      branch: "main",
      rootPath: "images",
      visibility: "PUBLIC",
    },
    manifest: { itemCount: 2, declaredBytes: 10, durationMs: 1_000 },
    ...overrides,
  };
}

async function post(cookie: string | undefined, body: unknown) {
  return request("/api/source-import-jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

test("source Job HTTP route enforces configured root and manifest limits before durable effects", { skip: sourceConnectionHttpEnabled ? false : sourceConnectionHttpSkipReason }, async () => {
  const unauthenticated = await post(undefined, publicSourceBody("cm000000000000000000000000"));
  assert.equal(unauthenticated.status, 401);

  const account = await signupAndLogin();
  const user = await db.user.findUniqueOrThrow({ where: { email: account.email }, select: { id: true } });
  users.push(user.id);
  const dataset = await db.dataset.create({
    data: { ownerId: user.id, name: `source-limit-http-${randomBytes(5).toString("hex")}` },
    select: { id: true },
  });

  const deniedCases = [
    publicSourceBody(dataset.id, { repository: { ...publicSourceBody(dataset.id).repository, rootPath: "images/nested" } }),
    publicSourceBody(dataset.id, { manifest: { itemCount: 3, declaredBytes: 10, durationMs: 1_000 } }),
    publicSourceBody(dataset.id, { manifest: { itemCount: 2, declaredBytes: 11, durationMs: 1_000 } }),
    publicSourceBody(dataset.id, { manifest: { itemCount: 2, declaredBytes: 10, durationMs: 1_001 } }),
    { ...publicSourceBody(dataset.id), policyOverride: { maxItems: 999_999 } },
  ];

  for (const body of deniedCases) {
    const before = await transportAndStorageSnapshot();
    const jobsBefore = await db.job.count({ where: { datasetId: dataset.id } });
    const response = await post(account.cookie, body);
    const payload = await response.json();
    assert.ok([400, 422].includes(response.status));
    assertNoSourceSecret(payload);
    assert.equal(await db.job.count({ where: { datasetId: dataset.id } }), jobsBefore);
    assertNoTransportOrStorageWrite(before, await transportAndStorageSnapshot());
  }

  const accepted = await post(account.cookie, publicSourceBody(dataset.id));
  assert.equal(accepted.status, 201);
  const acceptedPayload = await accepted.json() as { data: { job: { id: string; datasetId: string; type: string; status: string } } };
  assert.deepEqual(acceptedPayload.data.job.datasetId, dataset.id);
  assert.equal(acceptedPayload.data.job.type, "IMPORT_DATASET");
  assertNoSourceSecret(acceptedPayload);
  const job = await db.job.findUniqueOrThrow({ where: { id: acceptedPayload.data.job.id }, select: { input: true } });
  assert.deepEqual(job.input, {
    source: {
      repository: {
        provider: "GITEA",
        owner: "public-owner",
        repo: "public-repository",
        branch: "main",
        normalizedRootPath: "images",
        visibility: "PUBLIC",
      },
      manifest: { itemCount: 2, declaredBytes: 10, durationMs: 1_000 },
    },
  });
});
