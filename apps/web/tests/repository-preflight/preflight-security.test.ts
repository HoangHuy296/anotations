import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { PreflightError } from "@/lib/providers/provider-errors";
import { getRepositoryProvider } from "@/lib/providers/provider-registry";
import { db } from "@/lib/db";
import {
  assertNoPreflightSecret,
  assertNoPreflightWrite,
  preflightBusinessSnapshot,
  preflightHttpEnabled,
  preflightHttpSkipReason,
  preflightRequest,
  preflightTransportSnapshot,
  resetGithubFixtureCounter,
  githubFixtureRequestCount,
  githubFixturePathCount,
  giteaProviderAccessLogCountSince,
  registerAndLoginPreflightUser,
  removePreflightUser,
  sourceImportRequest,
} from "./helpers";
import {
  seedCorruptSourceConnection,
  seedExpiredSourceConnection,
  seedInvalidTokenSourceConnection,
  seedRevokedSourceConnection,
} from "./test-mode-fixtures";

test("adapter rejects a prohibited numeric destination before a provider request", async () => {
  await assert.rejects(
    getRepositoryProvider("GITHUB").preflight({
      provider: "GITHUB", baseUrl: "http://10.0.0.1", repository: { owner: "acme", name: "images" }, ref: null, rootPath: null, credential: null,
    }),
    (error: unknown) => error instanceof PreflightError && error.code === "UNSAFE_REPOSITORY_URL",
  );
});

test("adapter validates each redirect destination before following it", async () => {
  const previous = process.env.SOURCE_ALLOWED_IP_CIDRS;
  process.env.SOURCE_ALLOWED_IP_CIDRS = "127.0.0.1/32";
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(302, { Location: "http://10.0.0.1/metadata" });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind a TCP port");
  try {
    await assert.rejects(
      getRepositoryProvider("GITHUB").preflight({
        provider: "GITHUB", baseUrl: `http://127.0.0.1:${address.port}/`, repository: { owner: "acme", name: "images" }, ref: null, rootPath: null, credential: null,
      }),
      (error: unknown) => error instanceof PreflightError && error.code === "UNSAFE_REPOSITORY_URL",
    );
    assert.equal(requests, 1, "unsafe redirect target must not receive a second request");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previous === undefined) delete process.env.SOURCE_ALLOWED_IP_CIDRS; else process.env.SOURCE_ALLOWED_IP_CIDRS = previous;
  }
});

test("expired, revoked, corrupt, and provider-401 SourceConnection credentials share one concealed HTTP failure", {
  skip: preflightHttpEnabled ? false : "credential-state HTTP matrix requires controlled repository-preflight runtime",
}, async () => {
  const actor = await registerAndLoginPreflightUser();
  const seeded: string[] = [];
  try {
    const states = await Promise.all([
      seedExpiredSourceConnection(actor.userId),
      seedRevokedSourceConnection(actor.userId),
      seedCorruptSourceConnection(actor.userId),
      seedInvalidTokenSourceConnection(actor.userId),
    ]);
    seeded.push(...states.map((state) => state.id));
    const results: Array<{ status: number; error: unknown }> = [];
    for (const state of states) {
      const before = { business: await preflightBusinessSnapshot(), transport: await preflightTransportSnapshot() };
      const response = await sourceImportRequest("/api/source-import-preflight", actor.cookie, {
        provider: "GITEA",
        datasetName: "credential-state-must-not-persist",
        credentialMode: "EXISTING_SOURCE_CONNECTION",
        sourceConnectionId: state.id,
        repository: { owner: "annotation-admin", repo: "ImageDataset", ref: "main", expectedVisibility: "PUBLIC" },
      });
      const body = await response.json();
      assert.equal(response.status, 422);
      assert.equal(body.error.code, "SOURCE_TOKEN_INVALID");
      assertNoPreflightSecret(body);
      assertNoPreflightWrite(before.business, await preflightBusinessSnapshot());
      assertNoPreflightWrite(before.transport, await preflightTransportSnapshot());
      results.push({ status: response.status, error: body.error });
    }
    assert.deepEqual(results[1], results[0], "revocation must not have a distinguishable response shape");
    assert.deepEqual(results[2], results[0], "corrupt ciphertext must not have a distinguishable response shape");
    assert.deepEqual(results[3], results[0], "provider-side 401 must not have a distinguishable response shape");
  } finally {
    await db.sourceConnection.deleteMany({ where: { id: { in: seeded } } });
    await removePreflightUser(actor.userId);
  }
});

test("unknown SourceConnection is concealed before any provider access", {
  skip: preflightHttpEnabled ? false : preflightHttpSkipReason,
  // This optional Gitea access-log window must not overlap another provider
  // test if the global runner concurrency is changed later.
  concurrency: false,
}, async () => {
  const actor = await registerAndLoginPreflightUser();
  try {
    const before = { business: await preflightBusinessSnapshot(), transport: await preflightTransportSnapshot() };
    const windowStart = new Date();
    const response = await sourceImportRequest("/api/source-import-preflight", actor.cookie, {
      provider: "GITEA",
      datasetName: "unknown-connection-must-not-persist",
      credentialMode: "EXISTING_SOURCE_CONNECTION",
      sourceConnectionId: "cphase014unknownconnection000",
      repository: { owner: "annotation-admin", repo: "ImageDataset", ref: "main", expectedVisibility: "PUBLIC" },
    });
    const body = await response.json();
    assert.equal(response.status, 404);
    assert.equal(body.error.code, "SOURCE_CONNECTION_NOT_FOUND");
    assertNoPreflightSecret(body);
    assertNoPreflightWrite(before.business, await preflightBusinessSnapshot());
    assertNoPreflightWrite(before.transport, await preflightTransportSnapshot());
    const providerCalls = await giteaProviderAccessLogCountSince(windowStart);
    if (providerCalls !== null) assert.equal(providerCalls, 0, "unknown connection must be concealed before Gitea access");
  } finally {
    await removePreflightUser(actor.userId);
  }
});

test("authenticated DNS and URL policy denials occur before Gitea provider access", {
  // This test runs only against a recreated Compose web container whose
  // server-only SOURCE_TEST_DNS_OVERRIDES contains the three host fixtures.
  // It never receives resolver data from the browser request.
  skip: preflightHttpEnabled && process.env.PHASE014_DNS_MATRIX === "1"
    ? false
    : "DNS HTTP matrix requires a Compose web recreation with server-only resolver overrides",
}, async () => {
  const actor = await registerAndLoginPreflightUser();
  try {
    const cases = [
      "http://private.phase014.test",
      "http://mixed.phase014.test",
      "http://failure.phase014.test",
      "http://10.0.0.1",
      "http://user:pass@gitea:3000",
      "http://gitea:3000?unexpected=query",
      "http://gitea:3000#unexpected-fragment",
    ];
    const windowStart = new Date();
    for (const baseUrl of cases) {
      const before = { business: await preflightBusinessSnapshot(), transport: await preflightTransportSnapshot() };
      const response = await preflightRequest(actor.cookie, {
        provider: "GITEA",
        repository: { owner: "annotation-admin", name: "ImageDataset", baseUrl },
        ref: "main",
      });
      const body = await response.json();
      assert.equal(response.status, 400);
      assert.equal(body.error.code, "UNSAFE_REPOSITORY_URL");
      assertNoPreflightSecret(body, [baseUrl]);
      assertNoPreflightWrite(before.business, await preflightBusinessSnapshot());
      assertNoPreflightWrite(before.transport, await preflightTransportSnapshot());
    }
    const providerCalls = await giteaProviderAccessLogCountSince(windowStart);
    if (providerCalls !== null) assert.equal(providerCalls, 0, "DNS and URL policy denials must not call Gitea");
  } finally {
    await removePreflightUser(actor.userId);
  }
});

test("authenticated redirect policy rejects blocked and looped GitHub redirects safely", {
  skip: preflightHttpEnabled ? false : preflightHttpSkipReason,
}, async () => {
  const actor = await registerAndLoginPreflightUser();
  try {
    const cases = ["redirect-blocked", "redirect-loop"] as const;
    for (const name of cases) {
      await resetGithubFixtureCounter();
      const before = { business: await preflightBusinessSnapshot(), transport: await preflightTransportSnapshot() };
      const response = await preflightRequest(actor.cookie, {
        provider: "GITHUB",
        repository: { owner: "fixture", name },
      });
      const body = await response.json();
      assert.equal(response.status, 400);
      assert.equal(body.error.code, "UNSAFE_REPOSITORY_URL");
      assertNoPreflightSecret(body);
      if (name === "redirect-blocked") {
        assert.equal(await githubFixturePathCount("/repos/fixture/redirect-blocked"), 1, "controlled initial redirect endpoint is contacted exactly once");
        assert.equal(await githubFixturePathCount("/__test/blocked-target"), 0, "blocked redirect target must never be contacted");
      } else {
        const requests = await githubFixtureRequestCount();
        assert.ok(requests >= 1 && requests <= 4, "redirect loop must have a finite, policy-checked request budget");
        assert.ok(await githubFixturePathCount("/repos/fixture/redirect-loop") >= 1);
      }
      assertNoPreflightWrite(before.business, await preflightBusinessSnapshot());
      assertNoPreflightWrite(before.transport, await preflightTransportSnapshot());
    }
  } finally {
    await removePreflightUser(actor.userId);
  }
});
