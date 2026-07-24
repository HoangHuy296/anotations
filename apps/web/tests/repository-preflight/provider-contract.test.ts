import assert from "node:assert/strict";
import test from "node:test";

import { safePreflightFailure, PreflightError } from "@/lib/providers/provider-errors";
import { getRepositoryProvider } from "@/lib/providers/provider-registry";
import { repositoryPreflightSchema } from "@/lib/validation/repository-preflight";

test("preflight schema accepts only allowlisted repository selectors", () => {
  const valid = repositoryPreflightSchema.safeParse({
    provider: "GITEA",
    repository: { owner: "team", name: "images", baseUrl: "https://gitea.example.test" },
    ref: "main",
    rootPath: "images/train",
  });
  assert.equal(valid.success, true);

  for (const body of [
    { provider: "GITEA", repository: { owner: "team", name: "images", baseUrl: "https://gitea.example.test" }, token: "never-accepted" },
    { provider: "GITEA", repository: { owner: "team", name: "images", baseUrl: "https://gitea.example.test" }, queueName: "imports" },
    { provider: "GITHUB", repository: { owner: "team", name: "images", baseUrl: "https://override.example.test" } },
    { provider: "GITLAB", repository: { owner: "team", name: "images" } },
  ]) assert.equal(repositoryPreflightSchema.safeParse(body).success, false);
});

test("registry exposes only GitHub and Gitea adapters", () => {
  assert.equal(typeof getRepositoryProvider("GITHUB").preflight, "function");
  assert.equal(typeof getRepositoryProvider("GITEA").resolveRef, "function");
  assert.throws(() => getRepositoryProvider("GITLAB"), (error: unknown) => error instanceof PreflightError && error.code === "UNSUPPORTED_PROVIDER");
});

test("safe error projection has no provider diagnostics", () => {
  const failure = safePreflightFailure(new PreflightError("REPOSITORY_NOT_FOUND"));
  assert.deepEqual(failure, { status: 404, code: "REPOSITORY_NOT_FOUND", message: "The repository was not found." });
  assert.equal(JSON.stringify(failure).includes("http"), false);
  assert.equal(JSON.stringify(failure).includes("token"), false);
});

test("downloadFile remains declared but is unreachable in Phase 014", async () => {
  const adapter = getRepositoryProvider("GITHUB");
  await assert.rejects(
    adapter.downloadFile({
      baseUrl: "https://api.github.com",
      repository: { owner: "fieldframe", name: "demo" },
      credential: null,
      ref: "main",
      path: "image.jpg",
    }),
    (error: unknown) => error instanceof PreflightError,
  );
});
