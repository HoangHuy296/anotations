import test from "node:test";
import assert from "node:assert/strict";

import {
  assertNoPreflightSecret,
  assertNoPreflightWrite,
  createOwnedPreflightGiteaConnection,
  preflightBusinessSnapshot,
  preflightHttpEnabled,
  preflightHttpSkipReason,
  preflightRequest,
  preflightTransportSnapshot,
  registerAndLoginPreflightUser,
  removePreflightUser,
  sourceImportRequest,
} from "./helpers";

const controlledGiteaToken = process.env.SOURCE_CONNECTION_GITEA_TOKEN;

test("authenticated HTTP public GitHub preflight is safe and non-persistent", { skip: preflightHttpEnabled ? false : preflightHttpSkipReason }, async () => {
  const actor = await registerAndLoginPreflightUser();
  try {
    const before = { business: await preflightBusinessSnapshot(), transport: await preflightTransportSnapshot() };
    const unauthenticated = await preflightRequest(null, { provider: "GITHUB", repository: { owner: "fixture", name: "public-images" } });
    assert.equal(unauthenticated.status, 401);

    const response = await preflightRequest(actor.cookie, {
      provider: "GITHUB",
      repository: { owner: "fixture", name: "public-images" },
      ref: "main",
      rootPath: "images",
    });
    const body = await response.json();
    assert.equal(
      response.status,
      200,
      `public preflight failed with safe code ${String(body?.error?.code ?? "unknown")}`,
    );
    assert.deepEqual(body.preflight.repository, { owner: "fixture", name: "public-images" });
    assert.equal(body.preflight.ref.resolved, "main");
    assert.equal(body.preflight.rootPath.exists, true);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assertNoPreflightSecret(body);
    assertNoPreflightWrite(before.business, await preflightBusinessSnapshot());
    assertNoPreflightWrite(before.transport, await preflightTransportSnapshot());
  } finally {
    await removePreflightUser(actor.userId);
  }
});

test("authenticated HTTP public and owned Gitea preflight return safe metadata without durable writes", {
  skip: preflightHttpEnabled && controlledGiteaToken
    ? false
    : "controlled Gitea preflight skipped: requires Phase 014 HTTP settings and a local fixture token",
}, async () => {
  const actor = await registerAndLoginPreflightUser();
  try {
    const publicBefore = { business: await preflightBusinessSnapshot(), transport: await preflightTransportSnapshot() };
    const publicResponse = await preflightRequest(actor.cookie, {
      provider: "GITEA",
      repository: { owner: "annotation-admin", name: "ImageDataset", baseUrl: "http://gitea:3000" },
      ref: "main",
    });
    const publicBody = await publicResponse.json();
    assert.equal(publicResponse.status, 200);
    assert.equal(publicBody.preflight.provider, "GITEA");
    assert.equal(publicBody.preflight.repository.owner, "annotation-admin");
    assert.equal(publicBody.preflight.repository.name, "ImageDataset");
    assert.equal(publicBody.preflight.ref.resolved, "main");
    assertNoPreflightSecret(publicBody);
    assertNoPreflightWrite(publicBefore.business, await preflightBusinessSnapshot());
    assertNoPreflightWrite(publicBefore.transport, await preflightTransportSnapshot());

    const connectionId = await createOwnedPreflightGiteaConnection(actor.cookie, controlledGiteaToken!);
    const ownedBefore = { business: await preflightBusinessSnapshot(), transport: await preflightTransportSnapshot() };
    const ownedResponse = await preflightRequest(actor.cookie, {
      provider: "GITEA",
      repository: { owner: "annotation-admin", name: "ImageDataset" },
      ref: "main",
      sourceConnectionId: connectionId,
    });
    const ownedBody = await ownedResponse.json();
    assert.equal(ownedResponse.status, 200);
    assert.equal(ownedBody.preflight.provider, "GITEA");
    assert.equal(ownedBody.preflight.ref.resolved, "main");
    assertNoPreflightSecret(ownedBody, [controlledGiteaToken!]);
    assertNoPreflightWrite(ownedBefore.business, await preflightBusinessSnapshot());
    assertNoPreflightWrite(ownedBefore.transport, await preflightTransportSnapshot());
  } finally {
    await removePreflightUser(actor.userId);
  }
});

test("source Start Import rejects an unsaved one-time PAT before durable work", { skip: preflightHttpEnabled ? false : preflightHttpSkipReason }, async () => {
  const actor = await registerAndLoginPreflightUser();
  try {
    const before = { business: await preflightBusinessSnapshot(), transport: await preflightTransportSnapshot() };
    const sentinel = "one-time-pat-must-not-persist";
    const response = await sourceImportRequest("/api/source-import-jobs", actor.cookie, {
      provider: "GITEA",
      datasetName: "must-not-exist",
      credentialMode: "ONE_TIME_PAT",
      serverUrl: "http://github-fixture:8080",
      token: sentinel,
      saveAsSourceConnection: false,
      repository: { owner: "fixture", repo: "private-images", ref: "main", expectedVisibility: "PRIVATE" },
    });
    const body = await response.json();
    assert.equal(response.status, 422);
    assert.equal(body.error.code, "ONE_TIME_PAT_REQUIRES_SAVE_FOR_ASYNC_IMPORT");
    assertNoPreflightSecret(body, [sentinel]);
    assertNoPreflightWrite(before.business, await preflightBusinessSnapshot());
    assertNoPreflightWrite(before.transport, await preflightTransportSnapshot());
  } finally {
    await removePreflightUser(actor.userId);
  }
});

test("legacy Gitea import route returns its explicit migration response", { skip: preflightHttpEnabled ? false : preflightHttpSkipReason }, async () => {
  const actor = await registerAndLoginPreflightUser();
  try {
    const response = await sourceImportRequest("/api/gitea/import", actor.cookie, {});
    const body = await response.json();
    assert.equal(response.status, 410);
    assert.equal(body.error.code, "GITEA_IMPORT_DEPRECATED");
  } finally {
    await removePreflightUser(actor.userId);
  }
});

test("authenticated invalid GitHub preflight returns a stable safe failure with no side effects", { skip: preflightHttpEnabled ? false : preflightHttpSkipReason }, async () => {
  const actor = await registerAndLoginPreflightUser();
  try {
    const before = { business: await preflightBusinessSnapshot(), transport: await preflightTransportSnapshot() };
    const response = await preflightRequest(actor.cookie, {
      provider: "GITHUB",
      repository: { owner: "fixture", name: "not-found" },
    });
    const body = await response.json();
    assert.equal(
      response.status,
      404,
      `missing repository preflight failed with safe code ${String(body?.error?.code ?? "unknown")}`,
    );
    assert.equal(body.error.code, "REPOSITORY_NOT_FOUND");
    assertNoPreflightSecret(body);
    assertNoPreflightWrite(before.business, await preflightBusinessSnapshot());
    assertNoPreflightWrite(before.transport, await preflightTransportSnapshot());
  } finally {
    await removePreflightUser(actor.userId);
  }
});

test("authenticated HTTP validation, missing-ref, and missing-root failures are stable and non-persistent", {
  skip: preflightHttpEnabled ? false : preflightHttpSkipReason,
}, async () => {
  const actor = await registerAndLoginPreflightUser();
  try {
    const cases: Array<{ body: unknown; status: number; code: string }> = [
      {
        body: { provider: "GITLAB", repository: { owner: "fixture", name: "public-images" } },
        status: 400,
        code: "UNSUPPORTED_PROVIDER",
      },
      {
        body: { provider: "GITHUB", repository: { owner: "fixture", name: "public-images" }, ref: "missing-ref" },
        status: 404,
        code: "REF_NOT_FOUND",
      },
      {
        body: { provider: "GITHUB", repository: { owner: "fixture", name: "public-images" }, rootPath: "missing-root" },
        status: 404,
        code: "ROOT_PATH_NOT_FOUND",
      },
      {
        body: { provider: "GITHUB", repository: { owner: "fixture", name: "not-found" } },
        status: 404,
        code: "REPOSITORY_NOT_FOUND",
      },
    ];
    for (const expected of cases) {
      const before = { business: await preflightBusinessSnapshot(), transport: await preflightTransportSnapshot() };
      const response = await preflightRequest(actor.cookie, expected.body);
      const body = await response.json();
      assert.equal(response.status, expected.status);
      assert.equal(body.error.code, expected.code);
      assertNoPreflightSecret(body);
      assertNoPreflightWrite(before.business, await preflightBusinessSnapshot());
      assertNoPreflightWrite(before.transport, await preflightTransportSnapshot());
    }
  } finally {
    await removePreflightUser(actor.userId);
  }
});
