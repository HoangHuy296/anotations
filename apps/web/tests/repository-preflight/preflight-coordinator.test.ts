import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { UserRole } from "@internal/db";

import { preflightRepository } from "@/lib/providers/preflight-repository";

test("coordinator uses a server-controlled GitHub endpoint and returns only a safe result", async () => {
  const previousBase = process.env.GITHUB_API_BASE_URL;
  const previousCidrs = process.env.SOURCE_ALLOWED_IP_CIDRS;
  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    let body: unknown = {};
    if (path === "/repos/acme/images") body = { default_branch: "main", private: false };
    else if (path === "/repos/acme/images/commits/main") body = { sha: "safe-revision" };
    else { response.writeHead(404, { "Content-Type": "application/json" }); response.end("{}"); return; }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind a TCP port");
  process.env.GITHUB_API_BASE_URL = `http://127.0.0.1:${address.port}/`;
  process.env.SOURCE_ALLOWED_IP_CIDRS = "127.0.0.1/32";
  try {
    const result = await preflightRepository(
      { id: "actor", email: "actor@example.test", name: "Actor", role: UserRole.MANAGER },
      { provider: "GITHUB", repository: { owner: "acme", name: "images" } },
    );
    assert.deepEqual(result.repository, { owner: "acme", name: "images" });
    assert.equal(JSON.stringify(result).includes("127.0.0.1"), false);
    assert.equal(JSON.stringify(result).includes("token"), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousBase === undefined) delete process.env.GITHUB_API_BASE_URL; else process.env.GITHUB_API_BASE_URL = previousBase;
    if (previousCidrs === undefined) delete process.env.SOURCE_ALLOWED_IP_CIDRS; else process.env.SOURCE_ALLOWED_IP_CIDRS = previousCidrs;
  }
});
