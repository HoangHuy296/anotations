#!/usr/bin/env node
import http from "node:http";

const port = Number(process.env.GITHUB_FIXTURE_PORT || 8080);

// Deterministic fixture credentials only. They are not provider credentials,
// are never returned by the fixture, and must not be printed by test output.
const TOKENS = {
  validPrivate: "fixture-phase014-valid-private",
  invalid: "fixture-phase014-invalid",
  expired: "fixture-phase014-expired",
  denied: "fixture-phase014-denied",
};

const repos = new Map([
  ["fixture/public-images", {
    private: false,
    id: 1001,
    defaultBranch: "main",
    refs: { main: "1111111111111111111111111111111111111111" },
    paths: new Set(["", "images", "labels", "images/cat.jpg", "labels/classes.txt"]),
    files: [
      { path: "images/cat.jpg", type: "blob", sha: "imgsha111", size: 12 },
      { path: "labels/classes.txt", type: "blob", sha: "labelsha111", size: 6 },
    ],
  }],
  ["fixture/private-images", {
    private: true,
    requiredToken: TOKENS.validPrivate,
    id: 1002,
    defaultBranch: "main",
    refs: { main: "2222222222222222222222222222222222222222" },
    paths: new Set(["", "dataset", "dataset/images", "dataset/images/private-cat.jpg"]),
    files: [{ path: "dataset/images/private-cat.jpg", type: "blob", sha: "privatesha222", size: 12 }],
  }],
]);

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function bearer(request) {
  const match = String(request.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function tokenFailure(request) {
  const token = bearer(request);
  if (token === TOKENS.invalid || token === TOKENS.expired) return { status: 401, body: { message: "Bad credentials" } };
  if (token === TOKENS.denied) return { status: 403, body: { message: "Resource not accessible" } };
  return null;
}

function accessFailure(request, repository) {
  const failedToken = tokenFailure(request);
  if (failedToken) return failedToken;
  if (!repository.private) return null;
  if (!bearer(request)) return { status: 404, body: { message: "Not Found" } };
  if (bearer(request) !== repository.requiredToken) return { status: 403, body: { message: "Resource not accessible" } };
  return null;
}

const server = http.createServer((request, response) => {
  try {
    if (request.method !== "GET") return send(response, 405, { message: "Method Not Allowed" });
    const url = new URL(request.url || "/", `http://${request.headers.host}`);
    if (url.pathname === "/healthz") return send(response, 200, { ok: true });
    if (url.pathname === "/user") {
      const failure = tokenFailure(request);
      if (failure) return send(response, failure.status, failure.body);
      return bearer(request) ? send(response, 200, { login: "fixture-user", id: 9001 }) : send(response, 401, { message: "Requires authentication" });
    }

    const match = /^\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if (!match) return send(response, 404, { message: "Not Found" });
    const owner = decodeURIComponent(match[1]);
    const name = decodeURIComponent(match[2]);
    const repository = repos.get(`${owner}/${name}`);
    if (!repository) return send(response, 404, { message: "Not Found" });
    const denied = accessFailure(request, repository);
    if (denied) return send(response, denied.status, denied.body);

    const rest = match[3] || "";
    if (!rest) return send(response, 200, { id: repository.id, name, full_name: `${owner}/${name}`, private: repository.private, default_branch: repository.defaultBranch });

    const commit = /^commits\/(.+)$/.exec(rest);
    const gitRef = /^git\/ref\/heads\/(.+)$/.exec(rest);
    if (commit || gitRef) {
      const ref = decodeURIComponent((commit || gitRef)[1]);
      const sha = repository.refs[ref];
      return sha ? send(response, 200, commit ? { sha } : { ref: `refs/heads/${ref}`, object: { type: "commit", sha } }) : send(response, 404, { message: "Reference does not exist" });
    }

    const contents = /^contents\/?(.*)$/.exec(rest);
    if (contents) {
      const requested = decodeURIComponent(contents[1] || "").replace(/^\/+|\/+$/g, "");
      if (!repository.paths.has(requested)) return send(response, 404, { message: "Not Found" });
      return send(response, 200, repository.files.filter((file) => !requested || file.path.startsWith(`${requested}/`)).map((file) => ({
        name: file.path.split("/").pop(), path: file.path, sha: file.sha, size: file.size,
        type: file.type === "blob" ? "file" : "dir",
      })));
    }

    if (/^git\/trees\/[^/]+$/.test(rest)) return send(response, 200, { truncated: false, tree: repository.files });
    return send(response, 404, { message: "Not Found" });
  } catch {
    return send(response, 500, { message: "Fixture error" });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`[github-fixture] listening on ${port}`);
});
