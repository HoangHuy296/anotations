import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNoPreflightSecret,
  assertNoPreflightWrite,
  createOwnedPreflightGiteaConnection,
  preflightBusinessSnapshot,
  preflightHttpEnabled,
  preflightTransportSnapshot,
  registerAndLoginPreflightUser,
  removePreflightUser,
  sourceImportRequest,
} from "./helpers";

const token = process.env.SOURCE_CONNECTION_GITEA_TOKEN;
const publicRepository = { owner: "annotation-admin", repo: "ImageDataset", ref: "main", expectedVisibility: "PUBLIC" };

async function assertDenied(cookie: string | null, path: "/api/source-import-preflight" | "/api/source-import-jobs", body: unknown, expected: { status: number; code: string }, sentinels: string[] = []) {
  const before = { business: await preflightBusinessSnapshot(), transport: await preflightTransportSnapshot() };
  const response = await sourceImportRequest(path, cookie, body);
  const result = await response.json();
  assert.equal(response.status, expected.status);
  assert.equal(result.error.code, expected.code);
  assertNoPreflightSecret(result, sentinels);
  assertNoPreflightWrite(before.business, await preflightBusinessSnapshot());
  assertNoPreflightWrite(before.transport, await preflightTransportSnapshot());
}

test("source-import credential-mode denials are concealed, redacted, and side-effect free", {
  skip: preflightHttpEnabled && token ? false : "source-import denial matrix requires controlled HTTP settings and local Gitea fixture token",
}, async () => {
  const actor = await registerAndLoginPreflightUser();
  const foreign = await registerAndLoginPreflightUser();
  try {
    const foreignConnectionId = await createOwnedPreflightGiteaConnection(foreign.cookie, token!);
    const base = { provider: "GITEA", datasetName: "must-not-persist", repository: publicRepository };

    await assertDenied(actor.cookie, "/api/source-import-preflight", { ...base, credentialMode: "PUBLIC", serverUrl: "http://localhost:3100", sourceConnectionId: foreignConnectionId }, { status: 400, code: "INVALID_REQUEST" });
    await assertDenied(actor.cookie, "/api/source-import-preflight", { ...base, credentialMode: "EXISTING_SOURCE_CONNECTION", sourceConnectionId: foreignConnectionId, token: "sentinel-pat" }, { status: 400, code: "INVALID_REQUEST" }, ["sentinel-pat"]);
    await assertDenied(actor.cookie, "/api/source-import-preflight", { ...base, credentialMode: "EXISTING_SOURCE_CONNECTION", sourceConnectionId: foreignConnectionId }, { status: 404, code: "SOURCE_CONNECTION_NOT_FOUND" });
    await assertDenied(actor.cookie, "/api/source-import-preflight", { ...base, credentialMode: "EXISTING_SOURCE_CONNECTION", sourceConnectionId: "malformed-connection-id" }, { status: 404, code: "SOURCE_CONNECTION_NOT_FOUND" });
    await assertDenied(actor.cookie, "/api/source-import-jobs", { ...base, credentialMode: "ONE_TIME_PAT", serverUrl: "http://localhost:3100", token: "one-time-sentinel", saveAsSourceConnection: false }, { status: 422, code: "ONE_TIME_PAT_REQUIRES_SAVE_FOR_ASYNC_IMPORT" }, ["one-time-sentinel"]);
    await assertDenied(null, "/api/source-import-preflight", { ...base, credentialMode: "PUBLIC", serverUrl: "http://localhost:3100" }, { status: 401, code: "AUTH_REQUIRED" });
  } finally {
    await removePreflightUser(actor.userId);
    await removePreflightUser(foreign.userId);
  }
});
