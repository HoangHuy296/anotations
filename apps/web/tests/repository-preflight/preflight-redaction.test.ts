import assert from "node:assert/strict";
import test from "node:test";

import { safePreflightFailure, PreflightError } from "@/lib/providers/provider-errors";
import { db } from "@/lib/db";
import {
  assertNoPreflightSecret,
  assertNoPreflightWrite,
  preflightBusinessSnapshot,
  preflightHttpEnabled,
  preflightHttpSkipReason,
  preflightRequest,
  preflightTransportSnapshot,
  registerAndLoginPreflightUser,
  removePreflightUser,
  sourceImportRequest,
} from "./helpers";
import {
  seedCorruptSourceConnection,
  seedExpiredSourceConnection,
  seedInvalidTokenSourceConnection,
} from "./test-mode-fixtures";

test("safe semantic and operational failures contain no credential or stack sentinel", () => {
  const values = [
    safePreflightFailure(new PreflightError("SOURCE_TOKEN_EXPIRED")),
    safePreflightFailure(new Error("unexpected internal detail")),
  ];
  assertNoPreflightSecret(values, ["unexpected internal detail"]);
  assert.equal(JSON.stringify(values).includes("provider.example"), false);
});

test("HTTP success, failures, and concealed connections expose only safe response fields", {
  skip: preflightHttpEnabled && process.env.SOURCE_CONNECTION_TEST_MODE === "1"
    ? false
    : preflightHttpSkipReason,
}, async () => {
  const actor = await registerAndLoginPreflightUser();
  const foreign = await registerAndLoginPreflightUser();
  const seeded: string[] = [];
  try {
    const foreignConnection = await seedInvalidTokenSourceConnection(foreign.userId);
    const [expiredConnection, corruptConnection, invalidConnection] = await Promise.all([
      seedExpiredSourceConnection(actor.userId),
      seedCorruptSourceConnection(actor.userId),
      seedInvalidTokenSourceConnection(actor.userId),
    ]);
    seeded.push(foreignConnection.id, expiredConnection.id, corruptConnection.id, invalidConnection.id);
    const cases: Array<{ route: "preflight" | "source" | "legacy"; body: unknown; status: number; code?: string }> = [
      { route: "preflight", body: { provider: "GITHUB", repository: { owner: "fixture", name: "public-images" } }, status: 200 },
      { route: "preflight", body: { provider: "GITHUB", repository: { owner: "fixture", name: "not-found" } }, status: 404, code: "REPOSITORY_NOT_FOUND" },
      { route: "preflight", body: { provider: "GITHUB", repository: { owner: "fixture", name: "unavailable" } }, status: 503, code: "SOURCE_PROVIDER_UNAVAILABLE" },
      { route: "source", body: { provider: "GITEA", datasetName: "redaction", credentialMode: "EXISTING_SOURCE_CONNECTION", sourceConnectionId: foreignConnection.id, repository: { owner: "annotation-admin", repo: "ImageDataset", ref: "main", expectedVisibility: "PUBLIC" } }, status: 404, code: "SOURCE_CONNECTION_NOT_FOUND" },
      { route: "source", body: { provider: "GITEA", datasetName: "redaction", credentialMode: "EXISTING_SOURCE_CONNECTION", sourceConnectionId: "cphase014unknownconnection000", repository: { owner: "annotation-admin", repo: "ImageDataset", ref: "main", expectedVisibility: "PUBLIC" } }, status: 404, code: "SOURCE_CONNECTION_NOT_FOUND" },
      { route: "source", body: { provider: "GITEA", datasetName: "redaction", credentialMode: "EXISTING_SOURCE_CONNECTION", sourceConnectionId: "malformed-connection-id", repository: { owner: "annotation-admin", repo: "ImageDataset", ref: "main", expectedVisibility: "PUBLIC" } }, status: 404, code: "SOURCE_CONNECTION_NOT_FOUND" },
      { route: "source", body: { provider: "GITEA", datasetName: "redaction", credentialMode: "EXISTING_SOURCE_CONNECTION", sourceConnectionId: expiredConnection.id, repository: { owner: "annotation-admin", repo: "ImageDataset", ref: "main", expectedVisibility: "PUBLIC" } }, status: 422, code: "SOURCE_TOKEN_INVALID" },
      { route: "source", body: { provider: "GITEA", datasetName: "redaction", credentialMode: "EXISTING_SOURCE_CONNECTION", sourceConnectionId: corruptConnection.id, repository: { owner: "annotation-admin", repo: "ImageDataset", ref: "main", expectedVisibility: "PUBLIC" } }, status: 422, code: "SOURCE_TOKEN_INVALID" },
      { route: "source", body: { provider: "GITEA", datasetName: "redaction", credentialMode: "EXISTING_SOURCE_CONNECTION", sourceConnectionId: invalidConnection.id, repository: { owner: "annotation-admin", repo: "ImageDataset", ref: "main", expectedVisibility: "PUBLIC" } }, status: 422, code: "SOURCE_TOKEN_INVALID" },
      { route: "legacy", body: {}, status: 410, code: "GITEA_IMPORT_DEPRECATED" },
    ];
    for (const expected of cases) {
      const before = { business: await preflightBusinessSnapshot(), transport: await preflightTransportSnapshot() };
      const response = expected.route === "preflight"
        ? await preflightRequest(actor.cookie, expected.body)
        : await sourceImportRequest(expected.route === "legacy" ? "/api/gitea/import" : "/api/source-import-preflight", actor.cookie, expected.body);
      const body = await response.json();
      assert.equal(response.status, expected.status);
      if (expected.code) assert.equal(body.error.code, expected.code);
      assertNoPreflightSecret(body, ["fixture provider unavailable"]);
      assertNoPreflightWrite(before.business, await preflightBusinessSnapshot());
      assertNoPreflightWrite(before.transport, await preflightTransportSnapshot());
    }
  } finally {
    await db.sourceConnection.deleteMany({ where: { id: { in: seeded } } });
    await removePreflightUser(actor.userId);
    await removePreflightUser(foreign.userId);
  }
});
