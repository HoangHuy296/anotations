import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { PreflightError } from "@/lib/providers/provider-errors";
import { getRepositoryProvider } from "@/lib/providers/provider-registry";

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
