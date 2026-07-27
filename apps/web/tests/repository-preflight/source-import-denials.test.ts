import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNoPreflightSecret,
  assertNoPreflightWrite,
  createOwnedPreflightGiteaConnection,
  giteaProviderAccessLogCountSince,
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
    await assertDenied(actor.cookie, "/api/source-import-preflight", { ...base, credentialMode: "EXISTING_SOURCE_CONNECTION", sourceConnectionId: "cphase014unknownconnection000" }, { status: 404, code: "SOURCE_CONNECTION_NOT_FOUND" });
    // The controlled repository is actually private; without an owned active
    // SourceConnection it reaches the existing provider concealment mapper.
    await assertDenied(actor.cookie, "/api/source-import-preflight", {
      provider: "GITEA",
      datasetName: "private-without-connection-must-not-persist",
      credentialMode: "PUBLIC",
      serverUrl: "http://localhost:3100",
      repository: { owner: "annotation-admin", repo: "ImageDatasetPrivate", ref: "main", expectedVisibility: "PRIVATE" },
    // Local Gitea conceals an anonymous private repository with its normal
    // 404 response; preserve that mapper outcome instead of adding an oracle.
    }, { status: 404, code: "REPOSITORY_NOT_FOUND" });
    await assertDenied(actor.cookie, "/api/source-import-jobs", { ...base, credentialMode: "ONE_TIME_PAT", serverUrl: "http://localhost:3100", token: "one-time-sentinel", saveAsSourceConnection: false }, { status: 422, code: "ONE_TIME_PAT_REQUIRES_SAVE_FOR_ASYNC_IMPORT" }, ["one-time-sentinel"]);
    await assertDenied(null, "/api/source-import-preflight", { ...base, credentialMode: "PUBLIC", serverUrl: "http://localhost:3100" }, { status: 401, code: "AUTH_REQUIRED" });
  } finally {
    await removePreflightUser(actor.userId);
    await removePreflightUser(foreign.userId);
  }
});

test("pre-policy Gitea source-import denials make zero provider calls by access-log evidence", {
  // Real Gitea deliberately has no fixture counter route. This Compose-only
  // test uses its access log, counting only `/api/v1/` provider calls; the
  // ordinary health endpoint is not evidence either way.
  skip: preflightHttpEnabled && token && process.env.GITEA_ACCESS_LOG_ASSERTIONS === "1"
    ? false
    : "Gitea provider-call audit requires controlled Compose runtime and explicit access-log assertion mode",
  // The access-log window is process-global; keep this test serial even if
  // future test commands increase global file/test concurrency.
  concurrency: false,
}, async () => {
  const actor = await registerAndLoginPreflightUser();
  const foreign = await registerAndLoginPreflightUser();
  try {
    const foreignConnectionId = await createOwnedPreflightGiteaConnection(foreign.cookie, token!);
    // Gitea logs have second precision. Start this window only after setup is
    // complete so its validation request cannot contaminate the assertion.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const windowStart = new Date();
    const base = { provider: "GITEA", datasetName: "must-not-persist", repository: publicRepository };
    const denials: Array<{ body: unknown; expected: { status: number; code: string }; sentinels?: string[] }> = [
      { body: { ...base, credentialMode: "PUBLIC", serverUrl: "http://localhost:3100", sourceConnectionId: foreignConnectionId }, expected: { status: 400, code: "INVALID_REQUEST" } },
      { body: { ...base, credentialMode: "EXISTING_SOURCE_CONNECTION", sourceConnectionId: foreignConnectionId, token: "fixture-sentinel" }, expected: { status: 400, code: "INVALID_REQUEST" }, sentinels: ["fixture-sentinel"] },
      { body: { ...base, credentialMode: "EXISTING_SOURCE_CONNECTION", sourceConnectionId: foreignConnectionId }, expected: { status: 404, code: "SOURCE_CONNECTION_NOT_FOUND" } },
      { body: { ...base, credentialMode: "EXISTING_SOURCE_CONNECTION", sourceConnectionId: "malformed-connection-id" }, expected: { status: 404, code: "SOURCE_CONNECTION_NOT_FOUND" } },
    ];
    for (const denial of denials) {
      await assertDenied(actor.cookie, "/api/source-import-preflight", denial.body, denial.expected, denial.sentinels);
    }
    assert.equal(await giteaProviderAccessLogCountSince(windowStart), 0, "pre-policy and concealed-source denials must not call Gitea");
  } finally {
    await removePreflightUser(actor.userId);
    await removePreflightUser(foreign.userId);
  }
});
