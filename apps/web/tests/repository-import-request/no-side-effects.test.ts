import assert from "node:assert/strict";
import test from "node:test";

import { SourceConnectionStatus, UserRole } from "@internal/db";

import { db } from "@/lib/db";

import {
  assertNoRepositoryImportSecret,
  assertNoRepositoryImportSideEffect,
  cleanupRepositoryImportUser,
  createOwnedRepositoryImportGiteaConnection,
  publicGiteaRequest,
  publicGithubRequest,
  repositoryImportHttpEnabled,
  repositoryImportHttpSkipReason,
  repositoryImportRequest,
  repositoryImportSnapshot,
  registerAndLoginRepositoryImportUser,
} from "./helpers";

type ErrorResponse = { error?: { code?: string; message?: string; fieldErrors?: Record<string, string[]> } };

async function assertDenied(
  cookie: string | null,
  body: unknown,
  expected: { status: number; code: string },
  sentinels: readonly string[] = [],
) {
  const before = await repositoryImportSnapshot();
  const response = await repositoryImportRequest(cookie, body);
  const payload = await response.json() as ErrorResponse;
  assert.equal(response.status, expected.status);
  assert.equal(payload.error?.code, expected.code);
  assert.ok(payload.error?.message);
  assertNoRepositoryImportSecret(payload, sentinels);
  const after = await repositoryImportSnapshot();
  assertNoRepositoryImportSideEffect(before, after);
}

test("malformed, forbidden, unauthenticated, and non-manager requests create no durable side effect", {
  skip: repositoryImportHttpEnabled ? false : repositoryImportHttpSkipReason,
  concurrency: false,
}, async () => {
  const actor = await registerAndLoginRepositoryImportUser();
  try {
    await assertDenied(actor.cookie, { ...publicGithubRequest(), unknown: "forbidden" }, { status: 400, code: "INVALID_REQUEST" });
    await assertDenied(actor.cookie, { ...publicGithubRequest(), idempotencyKey: "short" }, { status: 400, code: "INVALID_REQUEST" });
    await assertDenied(actor.cookie, { ...publicGithubRequest(), provider: "GITHUB", sourceConnectionId: "forbidden-connection" }, { status: 400, code: "INVALID_REQUEST" });
    await assertDenied(null, publicGithubRequest(), { status: 401, code: "AUTH_REQUIRED" });

    await db.user.update({ where: { id: actor.userId }, data: { role: UserRole.LABELER } });
    await assertDenied(actor.cookie, publicGithubRequest(), { status: 403, code: "FORBIDDEN" });
  } finally {
    await cleanupRepositoryImportUser(actor.userId);
  }
});

test("foreign, malformed, expired, and revoked SourceConnections are concealed without durable side effects", {
  skip: repositoryImportHttpEnabled && process.env.SOURCE_CONNECTION_GITEA_TOKEN
    ? false
    : "SourceConnection concealment requires the controlled Gitea PAT and Phase-015 HTTP runtime",
  concurrency: false,
}, async () => {
  const owner = await registerAndLoginRepositoryImportUser();
  const foreign = await registerAndLoginRepositoryImportUser();
  try {
    const connectionId = await createOwnedRepositoryImportGiteaConnection(owner.cookie, process.env.SOURCE_CONNECTION_GITEA_TOKEN!);
    const privateRequest = (sourceConnectionId: string) => publicGiteaRequest({
      credentialMode: "EXISTING_SOURCE_CONNECTION",
      sourceConnectionId,
      repository: { owner: "annotation-admin", name: "ImageDatasetPrivate", ref: "main", expectedVisibility: "PRIVATE" },
    });
    await assertDenied(foreign.cookie, privateRequest(connectionId), { status: 404, code: "SOURCE_CONNECTION_NOT_FOUND" }, [process.env.SOURCE_CONNECTION_GITEA_TOKEN!]);
    await assertDenied(owner.cookie, privateRequest("malformed-source-connection"), { status: 404, code: "SOURCE_CONNECTION_NOT_FOUND" });

    await db.sourceConnection.update({ where: { id: connectionId }, data: { status: SourceConnectionStatus.EXPIRED, tokenExpiresAt: new Date(Date.now() - 60_000) } });
    // Ownership and identifier failures are concealed as 404. An owned but
    // expired/revoked connection is deliberately collapsed with every other
    // credential-invalid state, so it must use the Phase-013 422 policy.
    await assertDenied(owner.cookie, privateRequest(connectionId), { status: 422, code: "SOURCE_TOKEN_INVALID" }, [process.env.SOURCE_CONNECTION_GITEA_TOKEN!]);

    await db.sourceConnection.update({ where: { id: connectionId }, data: { status: SourceConnectionStatus.REVOKED, revokedAt: new Date() } });
    await assertDenied(owner.cookie, privateRequest(connectionId), { status: 422, code: "SOURCE_TOKEN_INVALID" }, [process.env.SOURCE_CONNECTION_GITEA_TOKEN!]);

    await db.sourceConnection.update({ where: { id: connectionId }, data: { status: SourceConnectionStatus.ERROR, revokedAt: null, tokenExpiresAt: null } });
    await assertDenied(owner.cookie, privateRequest(connectionId), { status: 422, code: "SOURCE_TOKEN_INVALID" }, [process.env.SOURCE_CONNECTION_GITEA_TOKEN!]);

    await db.sourceConnection.update({ where: { id: connectionId }, data: { status: SourceConnectionStatus.ACTIVE, tokenEncrypted: null } });
    await assertDenied(owner.cookie, privateRequest(connectionId), { status: 422, code: "SOURCE_TOKEN_INVALID" });
  } finally {
    await cleanupRepositoryImportUser(owner.userId);
    await cleanupRepositoryImportUser(foreign.userId);
  }
});

test("unsafe repository selections and provider preflight failures create no durable side effect", {
  skip: repositoryImportHttpEnabled ? false : repositoryImportHttpSkipReason,
  concurrency: false,
}, async () => {
  const actor = await registerAndLoginRepositoryImportUser();
  try {
    // Phase 015 has no browser-selectable provider URL. A supplied URL is a
    // forbidden body field and is rejected before any provider request.
    await assertDenied(actor.cookie, { ...publicGithubRequest(), repository: { ...publicGithubRequest().repository, baseUrl: "http://127.0.0.1" } }, { status: 400, code: "INVALID_REQUEST" });
    await assertDenied(actor.cookie, { ...publicGithubRequest(), provider: "GITLAB" }, { status: 400, code: "INVALID_REQUEST" });
    await assertDenied(actor.cookie, publicGithubRequest({ repository: { owner: "fixture", name: "missing-repository", ref: "main", expectedVisibility: "PUBLIC" } }), { status: 404, code: "REPOSITORY_NOT_FOUND" });
    await assertDenied(actor.cookie, publicGithubRequest({ repository: { owner: "fixture", name: "public-images", ref: "missing-ref", expectedVisibility: "PUBLIC" } }), { status: 404, code: "REF_NOT_FOUND" });
    await assertDenied(actor.cookie, publicGithubRequest({ repository: { owner: "fixture", name: "public-images", ref: "main", rootPath: "missing-root", expectedVisibility: "PUBLIC" } }), { status: 404, code: "ROOT_PATH_NOT_FOUND" });
  } finally {
    await cleanupRepositoryImportUser(actor.userId);
  }
});
