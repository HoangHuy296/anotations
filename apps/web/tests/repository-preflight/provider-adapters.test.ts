import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { getRepositoryProvider } from "@/lib/providers/provider-registry";
import { PreflightError } from "@/lib/providers/provider-errors";
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
