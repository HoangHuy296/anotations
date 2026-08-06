import "server-only";

import { Prisma, RepoAuthType, RepoProvider, SourceConnectionStatus, UserRole } from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import { db } from "@/lib/db";
import { createGiteaClient, GiteaClientError } from "@/lib/gitea";
import { decryptSourceToken, encryptSourceToken } from "@/lib/source-connection-crypto";
import { toSafeSourceConnection, type SafeSourceConnection } from "@/lib/source-connection-dto";
import { validateSourceBaseUrl } from "@/lib/source-access-policy";
import { configuredInternalBaseUrl, resolveServerReachableGiteaUrl } from "@/lib/providers/gitea-compose-url";
import { TERMINAL_JOB_STATUSES } from "@/lib/job-status";
import type { sourceConnectionCreateSchema } from "@/lib/validation/source-connection";
import type { z } from "zod";

type CreateInput = z.infer<typeof sourceConnectionCreateSchema>;
type SourceResult =
  | { ok: true; connection: SafeSourceConnection }
  | { ok: false; code: "SOURCE_URL_UNSAFE" | "SOURCE_DESTINATION_NOT_ALLOWED" | "SOURCE_CONNECTION_EXISTS" | "SOURCE_TOKEN_EXPIRED" | "SOURCE_TOKEN_INVALID" | "SOURCE_PROVIDER_UNAVAILABLE" };

const safeSelect = {
  id: true, provider: true, name: true, status: true, tokenExpiresAt: true, createdAt: true, updatedAt: true,
} as const;

export async function listSourceConnections(actor: RequestActor): Promise<SafeSourceConnection[]> {
  const connections = await db.sourceConnection.findMany({
    where: { provider: RepoProvider.GITEA, ...(actor.role === UserRole.ADMIN ? {} : { userId: actor.id }), revokedAt: null },
    select: safeSelect,
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });
  return connections.map(toSafeSourceConnection);
}

/**
 * Returns only the established safe projection. A foreign identifier is
 * deliberately indistinguishable from an unknown identifier for non-admin
 * actors, so callers can preserve the project's concealed-resource policy.
 */
export async function getSourceConnection(
  actor: RequestActor,
  id: string,
): Promise<SafeSourceConnection | null> {
  const connection = await db.sourceConnection.findFirst({
    where: {
      id,
      provider: RepoProvider.GITEA,
      revokedAt: null,
      ...(actor.role === UserRole.ADMIN ? {} : { userId: actor.id }),
    },
    select: safeSelect,
  });
  return connection ? toSafeSourceConnection(connection) : null;
}

function canonicalBaseUrl(url: URL) {
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname}`;
}

async function validateGiteaToken(baseUrl: string, token: string): Promise<{ ok: true } | Exclude<SourceResult, { ok: true }>> {
  try {
    await createGiteaClient({ baseUrl, token }).listRepositories({ page: 1, limit: 1 });
    return { ok: true };
  } catch (error) {
    if (error instanceof GiteaClientError) {
      if (error.kind === "unauthorized") return { ok: false, code: error.status === 401 ? "SOURCE_TOKEN_EXPIRED" : "SOURCE_TOKEN_INVALID" };
      return { ok: false, code: "SOURCE_PROVIDER_UNAVAILABLE" };
    }
    return { ok: false, code: "SOURCE_PROVIDER_UNAVAILABLE" };
  }
}

export async function createSourceConnection(actor: RequestActor, input: CreateInput): Promise<SourceResult> {
  // A submitted address equal to the configured public Gitea root resolves to
  // the internal Compose alias only for the live token check below; the
  // durable connection row always stores the public root the browser
  // submitted, matching every other stored SourceConnection and the worker's
  // later SSRF re-validation (which never sees or accepts the internal alias).
  const reachable = resolveServerReachableGiteaUrl(input.baseUrl);
  let callBaseUrl: string;
  let baseUrl: string;
  if (reachable.usesConfiguredInternalUrl) {
    const configuredInternal = configuredInternalBaseUrl(reachable.baseUrl);
    const configuredPublic = configuredInternalBaseUrl(input.baseUrl);
    if (!configuredInternal || !configuredPublic) return { ok: false, code: "SOURCE_URL_UNSAFE" };
    callBaseUrl = configuredInternal;
    baseUrl = configuredPublic;
  } else {
    const address = await validateSourceBaseUrl(reachable.baseUrl);
    if (!address.ok) {
      return {
        ok: false,
        code: address.code === "SOURCE_DESTINATION_NOT_ALLOWED"
          ? "SOURCE_DESTINATION_NOT_ALLOWED"
          : "SOURCE_URL_UNSAFE",
      };
    }
    callBaseUrl = canonicalBaseUrl(address.value);
    baseUrl = callBaseUrl;
  }
  const duplicate = await db.sourceConnection.findFirst({
    where: { userId: actor.id, provider: RepoProvider.GITEA, baseUrl, status: SourceConnectionStatus.ACTIVE, revokedAt: null },
    select: { id: true },
  });
  if (duplicate) return { ok: false, code: "SOURCE_CONNECTION_EXISTS" };

  const validation = await validateGiteaToken(callBaseUrl, input.token);
  if (!validation.ok) return validation;

  try {
    const connection = await db.$transaction(async (tx) => {
      const existing = await tx.sourceConnection.findFirst({
        where: { userId: actor.id, provider: RepoProvider.GITEA, baseUrl, status: SourceConnectionStatus.ACTIVE, revokedAt: null },
        select: { id: true },
      });
      if (existing) return null;
      return tx.sourceConnection.create({
        data: { userId: actor.id, provider: RepoProvider.GITEA, authType: RepoAuthType.TOKEN, baseUrl, name: input.name ?? null, tokenEncrypted: encryptSourceToken(input.token), status: SourceConnectionStatus.ACTIVE },
        select: safeSelect,
      });
    }, { isolationLevel: "Serializable" });
    return connection ? { ok: true, connection: toSafeSourceConnection(connection) } : { ok: false, code: "SOURCE_CONNECTION_EXISTS" };
  } catch {
    return { ok: false, code: "SOURCE_PROVIDER_UNAVAILABLE" };
  }
}

export async function deleteSourceConnection(actor: RequestActor, id: string) {
  // Source-backed Job creation reads the same row in a Serializable transaction.
  // Retrying a serialization conflict makes exactly one ordering durable: either
  // the Job reference wins (DELETE returns 409), or the revoke wins (creation
  // finds no eligible connection). Queue delivery remains post-commit.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await db.$transaction(async (tx) => {
        const connection = await tx.sourceConnection.findFirst({
          where: { id, provider: RepoProvider.GITEA, ...(actor.role === UserRole.ADMIN ? {} : { userId: actor.id }) },
          select: { id: true, revokedAt: true },
        });
        if (!connection || connection.revokedAt) return { ok: false as const, code: "SOURCE_CONNECTION_NOT_FOUND" as const };

        const inUse = await tx.job.count({
          where: { sourceConnectionId: id, status: { notIn: TERMINAL_JOB_STATUSES } },
        });
        if (inUse) return { ok: false as const, code: "SOURCE_CONNECTION_IN_USE" as const };

        const updated = await tx.sourceConnection.updateMany({
          where: { id, revokedAt: null, ...(actor.role === UserRole.ADMIN ? {} : { userId: actor.id }) },
          data: {
            status: SourceConnectionStatus.REVOKED,
            revokedAt: new Date(),
            tokenEncrypted: null,
            refreshTokenEncrypted: null,
          },
        });
        return updated.count === 1
          ? { ok: true as const }
          : { ok: false as const, code: "SOURCE_CONNECTION_NOT_FOUND" as const };
      }, { isolationLevel: "Serializable" });
      return result;
    } catch (error) {
      const retryable = error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
      if (!retryable || attempt === 2) throw error;
    }
  }
  return { ok: false as const, code: "SOURCE_CONNECTION_NOT_FOUND" as const };
}

export async function resolveOwnedSourceToken(actor: RequestActor, id: string) {
  const connection = await db.sourceConnection.findFirst({
    where: { id, provider: RepoProvider.GITEA, status: SourceConnectionStatus.ACTIVE, revokedAt: null, ...(actor.role === UserRole.ADMIN ? {} : { userId: actor.id }), OR: [{ tokenExpiresAt: null }, { tokenExpiresAt: { gt: new Date() } }] },
    select: { id: true, baseUrl: true, tokenEncrypted: true },
  });
  if (!connection?.tokenEncrypted) return null;
  // The stored row always holds the public Gitea root; resolve it back to a
  // reachable address the same way every other stored-connection path does.
  const reachable = resolveServerReachableGiteaUrl(connection.baseUrl);
  let baseUrl: string;
  if (reachable.usesConfiguredInternalUrl) {
    const configured = configuredInternalBaseUrl(reachable.baseUrl);
    if (!configured) return null;
    baseUrl = configured;
  } else {
    const address = await validateSourceBaseUrl(reachable.baseUrl);
    if (!address.ok) return null;
    baseUrl = canonicalBaseUrl(address.value);
  }
  try { return { id: connection.id, baseUrl, token: decryptSourceToken(connection.tokenEncrypted) }; } catch { return null; }
}
