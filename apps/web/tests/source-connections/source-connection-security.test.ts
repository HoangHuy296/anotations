import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { SourceConnectionStatus } from "@internal/db";
import { decryptSourceToken, encryptSourceToken } from "@/lib/source-connection-crypto";
import { containsForbiddenSourceData, toSafeSourceConnection } from "@/lib/source-connection-dto";

test("token encryption is authenticated and safe DTO excludes connection secrets", () => {
  process.env.SOURCE_CONNECTION_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const encrypted = encryptSourceToken("test-token-not-for-output");
  assert.notEqual(encrypted, "test-token-not-for-output");
  assert.equal(decryptSourceToken(encrypted), "test-token-not-for-output");
  const dto = toSafeSourceConnection({ id: "connection", provider: "GITEA", name: "test", status: SourceConnectionStatus.ACTIVE, tokenExpiresAt: null, createdAt: new Date(0), updatedAt: new Date(0) });
  assert.equal(containsForbiddenSourceData(dto), false);
  assert.equal(containsForbiddenSourceData({ tokenEncrypted: encrypted }), true);
});

test("malformed ciphertext never yields plaintext", () => {
  process.env.SOURCE_CONNECTION_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  assert.throws(() => decryptSourceToken("v1.invalid.invalid.invalid"));
});
