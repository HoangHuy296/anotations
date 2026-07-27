import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { getRepositoryProvider } from "@/lib/providers/provider-registry";
import { PreflightError } from "@/lib/providers/provider-errors";
import type { PreflightInput } from "@/lib/providers/provider.types";
import { startGithubFixture } from "./github-fixture";

async function controlledProvider(handler: (path: string) => { status?: number; body: unknown }) {
  const server = createServer((request, response) => {
    const result = handler(request.url ?? "/");
    response.writeHead(result.status ?? 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(result.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind a TCP port");
  return { baseUrl: `http://127.0.0.1:${address.port}/`, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

test("GitHub adapter resolves exact refs and performs only bounded root metadata checks", async () => {
  const previous = process.env.SOURCE_ALLOWED_IP_CIDRS;
  process.env.SOURCE_ALLOWED_IP_CIDRS = "127.0.0.1/32";
  const fixture = await controlledProvider((path) => {
    if (path === "/repos/acme/images") return { body: { default_branch: "main", private: false } };
    if (path === "/repos/acme/images/commits/release") return { body: { sha: "safe-revision" } };
    if (path === "/repos/acme/images/contents/photos?ref=release") return { body: [] };
    return { status: 404, body: {} };
  });
  try {
    const result = await getRepositoryProvider("GITHUB").preflight({
      provider: "GITHUB", baseUrl: fixture.baseUrl, repository: { owner: "acme", name: "images" }, ref: "release", rootPath: "photos", credential: null,
    });
    assert.deepEqual(result, {
      provider: "GITHUB", repository: { owner: "acme", name: "images" },
      visibility: "PUBLIC",
      ref: { requested: "release", resolved: "release", revision: "safe-revision" },
      rootPath: { requested: "photos", normalized: "photos", exists: true },
      assetPreview: null,
    });
  } finally {
    await fixture.close();
    if (previous === undefined) delete process.env.SOURCE_ALLOWED_IP_CIDRS; else process.env.SOURCE_ALLOWED_IP_CIDRS = previous;
  }
});

test("Gitea adapter resolves a default ref without downloading source bytes", async () => {
  const previous = process.env.SOURCE_ALLOWED_IP_CIDRS;
  process.env.SOURCE_ALLOWED_IP_CIDRS = "127.0.0.1/32";
  const fixture = await controlledProvider((path) => {
    if (path === "/api/v1/repos/acme/images") return { body: { default_branch: "main", private: false } };
    if (path === "/api/v1/repos/acme/images/git/commits/main") return { body: { sha: "safe-revision" } };
    if (path.startsWith("/api/v1/repos/acme/images/git/trees/main")) return { body: { tree: [], truncated: false } };
    return { status: 404, body: {} };
  });
  try {
    const result = await getRepositoryProvider("GITEA").preflight({
      provider: "GITEA", baseUrl: fixture.baseUrl, repository: { owner: "acme", name: "images" }, ref: null, rootPath: null, credential: null,
    });
    assert.equal(result.ref.resolved, "main");
    assert.equal(result.ref.revision, "safe-revision");
    assert.equal(result.rootPath.exists, true);
  } finally {
    await fixture.close();
    if (previous === undefined) delete process.env.SOURCE_ALLOWED_IP_CIDRS; else process.env.SOURCE_ALLOWED_IP_CIDRS = previous;
  }
});

test("GitHub fixture maps public, private, missing ref, and missing root deterministically", async () => {
  const previous = process.env.SOURCE_ALLOWED_IP_CIDRS;
  process.env.SOURCE_ALLOWED_IP_CIDRS = "127.0.0.1/32";
  const fixture = await startGithubFixture();
  const adapter = getRepositoryProvider("GITHUB");
  const base = { provider: "GITHUB" as const, baseUrl: fixture.baseUrl, repository: { owner: "fieldframe", name: "public" }, credential: null };
  try {
    await assert.rejects(
      adapter.preflight({ ...base, repository: { owner: "fieldframe", name: "private" }, ref: null, rootPath: null }),
      (error: unknown) => error instanceof PreflightError && error.code === "REPOSITORY_ACCESS_DENIED",
    );
    await assert.rejects(
      adapter.preflight({ ...base, ref: "missing-ref", rootPath: null }),
      (error: unknown) => error instanceof PreflightError && error.code === "REF_NOT_FOUND",
    );
    await assert.rejects(
      adapter.preflight({ ...base, ref: null, rootPath: "missing-root" }),
      (error: unknown) => error instanceof PreflightError && error.code === "ROOT_PATH_NOT_FOUND",
    );
    assert.ok(fixture.requests() >= 3);
  } finally {
    await fixture.close();
    if (previous === undefined) delete process.env.SOURCE_ALLOWED_IP_CIDRS; else process.env.SOURCE_ALLOWED_IP_CIDRS = previous;
  }
});

test("GitHub and Gitea adapters preserve the common safe contract and normalized failures", async () => {
  const previous = process.env.SOURCE_ALLOWED_IP_CIDRS;
  process.env.SOURCE_ALLOWED_IP_CIDRS = "127.0.0.1/32";
  const github = await controlledProvider((path) => {
    if (path === "/repos/acme/public") return { body: { default_branch: "main", private: false } };
    if (path === "/repos/acme/private") return { body: { default_branch: "main", private: true } };
    if (path === "/repos/acme/public/commits/main") return { body: { sha: "github-safe-revision" } };
    if (path === "/repos/acme/public/contents/images?ref=main") return { body: [] };
    if (path.includes("unavailable")) return { status: 503, body: { message: "upstream detail" } };
    return { status: 404, body: { message: "upstream detail" } };
  });
  const gitea = await controlledProvider((path) => {
    if (path === "/api/v1/repos/acme/public") return { body: { default_branch: "main", private: false } };
    if (path === "/api/v1/repos/acme/private") return { body: { default_branch: "main", private: true } };
    if (path === "/api/v1/repos/acme/invalid-token") return { status: 401, body: { message: "upstream detail" } };
    if (path === "/api/v1/repos/acme/public/git/commits/main") return { body: { sha: "gitea-safe-revision" } };
    if (path === "/api/v1/repos/acme/public/contents/images?ref=main") return { body: [] };
    if (path.startsWith("/api/v1/repos/acme/public/git/trees/main")) return { body: { tree: [], truncated: false } };
    if (path.includes("unavailable")) return { status: 503, body: { message: "upstream detail" } };
    return { status: 404, body: { message: "upstream detail" } };
  });
  const credential = { connectionId: "fixture-connection", baseUrl: gitea.baseUrl, token: "fixture-token" };
  const expectedFailure = async (provider: "GITHUB" | "GITEA", input: PreflightInput, code: string) => {
    await assert.rejects(getRepositoryProvider(provider).preflight(input), (error: unknown) => error instanceof PreflightError && error.code === code);
  };
  try {
    const githubResult = await getRepositoryProvider("GITHUB").preflight({
      provider: "GITHUB", baseUrl: github.baseUrl, repository: { owner: "acme", name: "public" }, ref: "main", rootPath: "images", credential: null,
    });
    const giteaResult = await getRepositoryProvider("GITEA").preflight({
      provider: "GITEA", baseUrl: gitea.baseUrl, repository: { owner: "acme", name: "public" }, ref: "main", rootPath: "images", credential,
    });
    for (const result of [githubResult, giteaResult]) {
      assert.deepEqual(Object.keys(result).sort(), ["assetPreview", "provider", "ref", "repository", "rootPath", "visibility"]);
      assert.deepEqual(result.repository, { owner: "acme", name: "public" });
      assert.equal(result.visibility, "PUBLIC");
      assert.deepEqual(result.ref.requested, "main");
      assert.equal(result.ref.resolved, "main");
      assert.equal(result.rootPath.requested, "images");
      assert.equal(result.rootPath.normalized, "images");
      assert.equal(result.rootPath.exists, true);
      assert.equal(JSON.stringify(result).includes("fixture-token"), false);
      assert.equal(JSON.stringify(result).includes("upstream detail"), false);
    }

    const failureCases: Array<{ provider: "GITHUB" | "GITEA"; baseUrl: string; repository: string; ref: string | null; rootPath: string | null; credential: typeof credential | null; code: string }> = [
      { provider: "GITHUB", baseUrl: github.baseUrl, repository: "missing", ref: null, rootPath: null, credential: null, code: "REPOSITORY_NOT_FOUND" },
      { provider: "GITEA", baseUrl: gitea.baseUrl, repository: "missing", ref: null, rootPath: null, credential: null, code: "REPOSITORY_NOT_FOUND" },
      { provider: "GITHUB", baseUrl: github.baseUrl, repository: "private", ref: null, rootPath: null, credential: null, code: "REPOSITORY_ACCESS_DENIED" },
      { provider: "GITEA", baseUrl: gitea.baseUrl, repository: "private", ref: null, rootPath: null, credential: null, code: "REPOSITORY_ACCESS_DENIED" },
      { provider: "GITHUB", baseUrl: github.baseUrl, repository: "public", ref: "missing", rootPath: null, credential: null, code: "REF_NOT_FOUND" },
      { provider: "GITEA", baseUrl: gitea.baseUrl, repository: "public", ref: "missing", rootPath: null, credential, code: "REF_NOT_FOUND" },
      { provider: "GITHUB", baseUrl: github.baseUrl, repository: "public", ref: "main", rootPath: "missing", credential: null, code: "ROOT_PATH_NOT_FOUND" },
      { provider: "GITEA", baseUrl: gitea.baseUrl, repository: "public", ref: "main", rootPath: "missing", credential, code: "ROOT_PATH_NOT_FOUND" },
      { provider: "GITHUB", baseUrl: github.baseUrl, repository: "unavailable", ref: null, rootPath: null, credential: null, code: "PROVIDER_UNAVAILABLE" },
      { provider: "GITEA", baseUrl: gitea.baseUrl, repository: "unavailable", ref: null, rootPath: null, credential, code: "PROVIDER_UNAVAILABLE" },
      { provider: "GITEA", baseUrl: gitea.baseUrl, repository: "invalid-token", ref: null, rootPath: null, credential, code: "SOURCE_TOKEN_INVALID" },
    ];
    for (const expected of failureCases) {
      await expectedFailure(expected.provider, {
        provider: expected.provider,
        baseUrl: expected.baseUrl,
        repository: { owner: "acme", name: expected.repository },
        ref: expected.ref,
        rootPath: expected.rootPath,
        credential: expected.credential,
      }, expected.code);
    }
  } finally {
    await github.close();
    await gitea.close();
    if (previous === undefined) delete process.env.SOURCE_ALLOWED_IP_CIDRS; else process.env.SOURCE_ALLOWED_IP_CIDRS = previous;
  }
});
