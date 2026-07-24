import { createServer, type Server } from "node:http";

type Fixture = {
  baseUrl: string;
  requests: () => number;
  close: () => Promise<void>;
};

/**
 * Deliberately tiny local GitHub-compatible metadata fixture. It contains no
 * real GitHub token or network call and exposes only Phase-014 endpoints.
 */
export async function startGithubFixture(): Promise<Fixture> {
  let requestCount = 0;
  const server: Server = createServer((request, response) => {
    requestCount += 1;
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };

    const repoMatch = /^\/repos\/fieldframe\/([^/]+)$/.exec(url.pathname);
    if (repoMatch) {
      const repo = repoMatch[1];
      if (repo === "not-found") return json(404, {});
      if (repo === "denied" || repo === "invalid-token") return json(403, {});
      if (repo === "expired-token") return json(401, {});
      return json(200, { default_branch: "main", private: repo === "private" });
    }

    const refMatch = /^\/repos\/fieldframe\/([^/]+)\/commits\/([^/]+)$/.exec(url.pathname);
    if (refMatch) {
      if (refMatch[2] === "missing-ref") return json(404, {});
      return json(200, { sha: `revision-${refMatch[2]}` });
    }

    const rootMatch = /^\/repos\/fieldframe\/([^/]+)\/contents(?:\/(.*))?$/.exec(url.pathname);
    if (rootMatch) {
      if (rootMatch[2] === "missing-root") return json(404, {});
      return json(200, [{ path: rootMatch[2] ?? "", type: "dir" }]);
    }

    return json(404, {});
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("GitHub fixture did not bind a TCP port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    requests: () => requestCount,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
