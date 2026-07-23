import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after } from "node:test";

import { RepoAuthType, RepoProvider, SourceConnectionStatus } from "@internal/db";

import { db } from "@/lib/db";
import { encryptSourceToken } from "@/lib/source-connection-crypto";
import {
  assertNoBusinessWrite,
  assertNoSourceSecret,
  assertNoTransportOrStorageWrite,
  businessSnapshot,
  request,
  signupAndLogin,
  sourceConnectionHttpEnabled,
  sourceConnectionHttpSkipReason,
  transportAndStorageSnapshot,
} from "./helpers";

const cleanupUserIds: string[] = [];
after(async () => {
  await db.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
});

test("authenticated root-path rejection and browser policy override have no side effects before provider access", { skip: sourceConnectionHttpEnabled ? false : sourceConnectionHttpSkipReason }, async () => {
  const actor = await signupAndLogin();
  const user = await db.user.findUniqueOrThrow({ where: { email: actor.email }, select: { id: true } });
  cleanupUserIds.push(user.id);
  const connection = await db.sourceConnection.create({
    data: {
      userId: user.id,
      provider: RepoProvider.GITEA,
      authType: RepoAuthType.TOKEN,
      baseUrl: "http://gitea:3000",
      tokenEncrypted: encryptSourceToken("root-policy-token-sentinel"),
      status: SourceConnectionStatus.ACTIVE,
      name: `root-policy-${randomBytes(4).toString("hex")}`,
    },
    select: { id: true },
  });

  const beforeRoot = await businessSnapshot();
  const transportBeforeRoot = await transportAndStorageSnapshot();
  const rootResponse = await request("/api/gitea/import", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: actor.cookie },
    body: JSON.stringify({
      sourceConnectionId: connection.id,
      owner: "owner",
      repo: "repo",
      branch: "main",
      rootPath: "../outside",
      name: "Unsafe root",
      mode: "preview",
    }),
  });
  assert.equal(rootResponse.status, 400);
  assertNoSourceSecret(await rootResponse.json(), ["root-policy-token-sentinel"]);
  assertNoBusinessWrite(beforeRoot, await businessSnapshot());
  assertNoTransportOrStorageWrite(transportBeforeRoot, await transportAndStorageSnapshot());

  const beforeOverride = await businessSnapshot();
  const transportBeforeOverride = await transportAndStorageSnapshot();
  const overrideResponse = await request("/api/source-connections", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: actor.cookie },
    body: JSON.stringify({
      provider: "GITEA",
      baseUrl: "http://10.0.0.1",
      token: "browser-policy-token-sentinel",
      allowedIpCidrs: ["10.0.0.0/8"],
    }),
  });
  assert.equal(overrideResponse.status, 400);
  assertNoSourceSecret(await overrideResponse.json(), ["browser-policy-token-sentinel"]);
  assertNoBusinessWrite(beforeOverride, await businessSnapshot());
  assertNoTransportOrStorageWrite(transportBeforeOverride, await transportAndStorageSnapshot());
});

test("authenticated POST rejects deterministic private and mixed DNS answers before token/provider validation", { skip: sourceConnectionHttpEnabled ? false : sourceConnectionHttpSkipReason }, async () => {
  const actor = await signupAndLogin();
  cleanupUserIds.push((await db.user.findUniqueOrThrow({ where: { email: actor.email }, select: { id: true } })).id);
  const tokenSentinel = "dns-policy-token-must-not-reach-provider";
  for (const hostname of ["private-dns.test", "mixed-dns.test", "resolver-error.test"]) {
    const before = await businessSnapshot();
    const transportBefore = await transportAndStorageSnapshot();
    const response = await request("/api/source-connections", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: actor.cookie },
      body: JSON.stringify({ provider: "GITEA", name: "DNS policy test", baseUrl: `https://${hostname}`, token: tokenSentinel }),
    });
    assert.equal(response.status, 400, hostname);
    const body = await response.json() as { error: { code: string } };
    assert.equal(body.error.code, "SOURCE_DESTINATION_NOT_ALLOWED", hostname);
    assert.notEqual(body.error.code, "SOURCE_TOKEN_EXPIRED", "DNS policy must run before token validation");
    assertNoSourceSecret(body, [tokenSentinel]);
    assertNoBusinessWrite(before, await businessSnapshot());
    assertNoTransportOrStorageWrite(transportBefore, await transportAndStorageSnapshot());
  }
});
