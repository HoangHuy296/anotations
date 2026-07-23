import assert from "node:assert/strict";
import test, { after } from "node:test";

import { db } from "@/lib/db";
import {
  assertNoBusinessWrite,
  assertNoTransportOrStorageWrite,
  assertNoSourceSecret,
  businessSnapshot,
  controlledGiteaInput,
  request,
  signupAndLogin,
  sourceConnectionHttpEnabled,
  sourceConnectionHttpSkipReason,
  transportAndStorageSnapshot,
} from "./helpers";

const cleanupUserIds: string[] = [];

after(async () => {
  if (cleanupUserIds.length) await db.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
});

test("failed source-connection POSTs have no PostgreSQL business side effects or token leakage", {
  skip: sourceConnectionHttpEnabled ? false : sourceConnectionHttpSkipReason,
}, async () => {
  const actor = await signupAndLogin();
  cleanupUserIds.push((await db.user.findUniqueOrThrow({ where: { email: actor.email }, select: { id: true } })).id);
  const sentinel = process.env.SOURCE_CONNECTION_GITEA_TOKEN ?? "";
  const cases = [
    { name: "rejected provider token", input: controlledGiteaInput("not-a-valid-provider-token"), status: 422, code: "SOURCE_TOKEN_EXPIRED" },
    { name: "blocked numeric private address", input: controlledGiteaInput(sentinel), baseUrl: "http://10.0.0.1:3000", status: 400, code: "SOURCE_DESTINATION_NOT_ALLOWED" },
    { name: "blocked private hostname", input: controlledGiteaInput(sentinel), baseUrl: "http://localhost:3000", status: 400, code: "SOURCE_DESTINATION_NOT_ALLOWED" },
    { name: "allowlisted exact IP reaches non-Gitea Fieldframe", input: controlledGiteaInput(sentinel), baseUrl: "http://127.0.0.1:3000", status: 422, code: "SOURCE_TOKEN_EXPIRED" },
    { name: "allowlisted CIDR reaches non-Gitea Fieldframe", input: controlledGiteaInput(sentinel), baseUrl: "http://127.0.0.3:3000", status: 422, code: "SOURCE_TOKEN_EXPIRED" },
    { name: "allowlisted destination is TCP unavailable", input: controlledGiteaInput(sentinel), baseUrl: "http://127.0.0.1:65534", status: 503, code: "SOURCE_PROVIDER_UNAVAILABLE" },
  ];
  for (const current of cases) {
    const before = await businessSnapshot();
    const transportBefore = await transportAndStorageSnapshot();
    const response = await request("/api/source-connections", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: actor.cookie },
      body: JSON.stringify({ ...current.input, ...(current.baseUrl ? { baseUrl: current.baseUrl } : {}) }),
    });
    assert.equal(response.status, current.status, `${current.name}: unexpected status`);
    const body = await response.json() as { error: { code: string } };
    assert.equal(body.error.code, current.code, `${current.name}: unexpected error code`);
    if (current.name.startsWith("allowlisted")) {
      assert.notEqual(body.error.code, "SOURCE_DESTINATION_NOT_ALLOWED");
    }
    assertNoSourceSecret(body, [sentinel, "not-a-valid-provider-token"]);
    assertNoBusinessWrite(before, await businessSnapshot());
    assertNoTransportOrStorageWrite(transportBefore, await transportAndStorageSnapshot());
  }
});
