import assert from "node:assert/strict";

import { RepoAuthType, RepoProvider, SourceConnectionStatus } from "@internal/db";

import { db } from "@/lib/db";
import { encryptSourceToken } from "@/lib/source-connection-crypto";

/** Direct database fixtures are permitted only to model states the public API
 * cannot create (expired/corrupt ciphertext). All assertions still call real
 * HTTP routes with a normal opaque session cookie. */
export function requireRepositoryPreflightFixtureMode() {
  assert.equal(process.env.REPOSITORY_PREFLIGHT_INTEGRATION_TESTS, "1", "fixture seeding requires repository-preflight integration mode");
  assert.equal(process.env.SOURCE_CONNECTION_TEST_MODE, "1", "fixture seeding requires source connection test mode");
}

export async function seedCorruptSourceConnection(userId: string) {
  requireRepositoryPreflightFixtureMode();
  return db.sourceConnection.create({
    data: {
      userId,
      provider: RepoProvider.GITEA,
      authType: RepoAuthType.TOKEN,
      name: "corrupt Phase 014 fixture",
      baseUrl: "http://gitea:3000",
      // Intentionally malformed versioned envelope; never a real credential.
      tokenEncrypted: "v1.invalid-fixture-ciphertext",
      status: SourceConnectionStatus.ACTIVE,
    },
    select: { id: true },
  });
}

export async function seedExpiredSourceConnection(userId: string) {
  requireRepositoryPreflightFixtureMode();
  return db.sourceConnection.create({
    data: {
      userId,
      provider: RepoProvider.GITEA,
      authType: RepoAuthType.TOKEN,
      name: "expired Phase 014 fixture",
      baseUrl: "http://gitea:3000",
      tokenEncrypted: "v1.invalid-fixture-ciphertext",
      status: SourceConnectionStatus.EXPIRED,
      tokenExpiresAt: new Date(Date.now() - 60_000),
    },
    select: { id: true },
  });
}

export async function seedInvalidTokenSourceConnection(userId: string) {
  requireRepositoryPreflightFixtureMode();
  return db.sourceConnection.create({
    data: {
      userId,
      provider: RepoProvider.GITEA,
      authType: RepoAuthType.TOKEN,
      name: "invalid-token Phase 014 fixture",
      baseUrl: "http://gitea:3000",
      tokenEncrypted: encryptSourceToken("phase014-invalid-fixture-token"),
      status: SourceConnectionStatus.ACTIVE,
    },
    select: { id: true },
  });
}

export async function seedRevokedSourceConnection(userId: string) {
  requireRepositoryPreflightFixtureMode();
  return db.sourceConnection.create({
    data: {
      userId,
      provider: RepoProvider.GITEA,
      authType: RepoAuthType.TOKEN,
      name: "revoked Phase 014 fixture",
      baseUrl: "http://gitea:3000",
      // This intentionally non-secret value must never be decrypted because
      // the status/revokedAt eligibility check happens first.
      tokenEncrypted: "v1.invalid-fixture-ciphertext",
      status: SourceConnectionStatus.REVOKED,
      revokedAt: new Date(),
    },
    select: { id: true },
  });
}
