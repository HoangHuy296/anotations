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
  githubFixtureRequestCount,
  registerAndLoginPreflightUser,
  resetGithubFixtureCounter,
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
    const response = await sourceImportRequest("/api/datasets/from-repository", actor.cookie, {
      provider: "GITEA",
      datasetName: "must-not-exist",
      credentialMode: "ONE_TIME_PAT",
      serverUrl: "http://github-fixture:8080",
      personalAccessToken: sentinel,
      saveAsSourceConnection: false,
      repository: { owner: "fixture", name: "private-images", ref: "main", expectedVisibility: "PRIVATE" },
      idempotencyKey: "phase015-preflight-unsaved-one-time-pat",
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

test("forbidden GitHub preflight bodies are rejected before any provider call", {
  skip: preflightHttpEnabled ? false : preflightHttpSkipReason,
}, async () => {
  const actor = await registerAndLoginPreflightUser();
  try {
    const cases = [
      { provider: "GITHUB", repository: { owner: "fixture", name: "public-images" }, sourceConnectionId: "not-allowed" },
      { provider: "GITHUB", repository: { owner: "fixture", name: "public-images" }, token: "fixture-sentinel" },
      { provider: "GITLAB", repository: { owner: "fixture", name: "public-images" } },
    ];
    for (const request of cases) {
      await resetGithubFixtureCounter();
      const before = { business: await preflightBusinessSnapshot(), transport: await preflightTransportSnapshot() };
      const response = await preflightRequest(actor.cookie, request);
      const body = await response.json();
      assert.equal(response.status, 400);
      assertNoPreflightSecret(body, ["fixture-sentinel"]);
      assert.equal(await githubFixtureRequestCount(), 0, "forbidden body must not reach the GitHub provider fixture");
      assertNoPreflightWrite(before.business, await preflightBusinessSnapshot());
      assertNoPreflightWrite(before.transport, await preflightTransportSnapshot());
    }
  } finally {
    await removePreflightUser(actor.userId);
  }
});

test("public GitHub and Gitea keep the common safe preflight envelope, while private GitHub is denied", {
  skip: preflightHttpEnabled ? false : preflightHttpSkipReason,
}, async () => {
  const actor = await registerAndLoginPreflightUser();
  try {
    const githubResponse = await preflightRequest(actor.cookie, {
      provider: "GITHUB",
      repository: { owner: "fixture", name: "public-images" },
      ref: "main",
      rootPath: "images",
    });
    const giteaResponse = await preflightRequest(actor.cookie, {
      provider: "GITEA",
      repository: { owner: "annotation-admin", name: "ImageDataset", baseUrl: "http://gitea:3000" },
      ref: "main",
    });
    const github = await githubResponse.json();
    const gitea = await giteaResponse.json();
    assert.equal(githubResponse.status, 200);
    assert.equal(giteaResponse.status, 200);
    assert.deepEqual(Object.keys(github.preflight).sort(), Object.keys(gitea.preflight).sort());
    assert.deepEqual(Object.keys(github.preflight.ref).sort(), Object.keys(gitea.preflight.ref).sort());
    assert.deepEqual(Object.keys(github.preflight.rootPath).sort(), Object.keys(gitea.preflight.rootPath).sort());
    assertNoPreflightSecret(github);
    assertNoPreflightSecret(gitea);

    const before = { business: await preflightBusinessSnapshot(), transport: await preflightTransportSnapshot() };
    const denied = await preflightRequest(actor.cookie, {
      provider: "GITHUB",
      repository: { owner: "fixture", name: "private-images" },
    });
    const deniedBody = await denied.json();
    // Anonymous GitHub private repositories are intentionally concealed by
    // the provider. The common contract preserves that safe 404 rather than
    // inventing a 403 existence oracle.
    assert.equal(denied.status, 404);
    assert.equal(deniedBody.error.code, "REPOSITORY_NOT_FOUND");
    assertNoPreflightSecret(deniedBody);
    assertNoPreflightWrite(before.business, await preflightBusinessSnapshot());
    assertNoPreflightWrite(before.transport, await preflightTransportSnapshot());
  } finally {
    await removePreflightUser(actor.userId);
  }
});

test("GitHub and Gitea HTTP failures use the same safe envelope for repository, ref, and root selectors", {
  skip: preflightHttpEnabled ? false : preflightHttpSkipReason,
}, async () => {
  const actor = await registerAndLoginPreflightUser();
  try {
    const cases: Array<{ github: unknown; gitea: unknown; status: number; code: string }> = [
      {
        github: { provider: "GITHUB", repository: { owner: "fixture", name: "not-found" } },
        gitea: { provider: "GITEA", repository: { owner: "annotation-admin", name: "RepositoryThatDoesNotExist", baseUrl: "http://gitea:3000" } },
        status: 404,
        code: "REPOSITORY_NOT_FOUND",
      },
      {
        github: { provider: "GITHUB", repository: { owner: "fixture", name: "public-images" }, ref: "missing-ref" },
        gitea: { provider: "GITEA", repository: { owner: "annotation-admin", name: "ImageDataset", baseUrl: "http://gitea:3000" }, ref: "missing-ref" },
        status: 404,
        code: "REF_NOT_FOUND",
      },
      {
        github: { provider: "GITHUB", repository: { owner: "fixture", name: "public-images" }, rootPath: "missing-root" },
        gitea: { provider: "GITEA", repository: { owner: "annotation-admin", name: "ImageDataset", baseUrl: "http://gitea:3000" }, rootPath: "missing-root" },
        status: 404,
        code: "ROOT_PATH_NOT_FOUND",
      },
    ];
    for (const expected of cases) {
      const before = { business: await preflightBusinessSnapshot(), transport: await preflightTransportSnapshot() };
      const githubResponse = await preflightRequest(actor.cookie, expected.github);
      const giteaResponse = await preflightRequest(actor.cookie, expected.gitea);
      const github = await githubResponse.json();
      const gitea = await giteaResponse.json();
      assert.equal(githubResponse.status, expected.status);
      assert.equal(giteaResponse.status, expected.status);
      assert.equal(github.error.code, expected.code);
      assert.deepEqual(gitea.error, github.error, "providers must share the safe error envelope for equivalent selector failures");
      assertNoPreflightSecret(github);
      assertNoPreflightSecret(gitea);
      assertNoPreflightWrite(before.business, await preflightBusinessSnapshot());
      assertNoPreflightWrite(before.transport, await preflightTransportSnapshot());
    }
  } finally {
    await removePreflightUser(actor.userId);
  }
});
