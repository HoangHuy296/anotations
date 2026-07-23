import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createGiteaClient, GiteaClientError } from "@/lib/gitea";

async function withRedirectServer(location: string, run: (baseUrl: string) => Promise<void>) {
  const server = createServer((_request, response) => {
    response.writeHead(302, { Location: location });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

for (const [name, location] of [
  ["loopback destination", "http://127.0.0.1:1/"],
  ["outside-policy destination", "https://example.invalid/"],
  ["redirect loop", "/api/v1/user/repos"],
] as const) {
  test(`Gitea client fails closed for redirect to ${name}`, async () => {
    await withRedirectServer(location, async (baseUrl) => {
      await assert.rejects(
        () => createGiteaClient({ baseUrl, token: "test-token" }).listRepositories({ page: 1, limit: 1 }),
        (error: unknown) => error instanceof GiteaClientError && error.kind === "unavailable",
      );
    });
  });
}
