import "server-only";

import { RepoProvider, SourceConnectionStatus, UserRole } from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import { db } from "@/lib/db";
import { PreflightError } from "@/lib/providers/provider-errors";
import type { ServerCredentialContext } from "@/lib/providers/provider.types";
import { decryptSourceToken } from "@/lib/source-connection-crypto";
import { validateSourceBaseUrl } from "@/lib/source-access-policy";

function canonicalBaseUrl(url: URL) {
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname}`;
}

/**
 * Resolves an existing Gitea credential only after ownership and eligibility
 * checks. It returns transient memory-only material to provider code; no route
 * or DTO can observe the token.
 */
export async function resolvePreflightGiteaCredential(
  actor: RequestActor,
  sourceConnectionId: string,
): Promise<ServerCredentialContext> {
  const connection = await db.sourceConnection.findFirst({
    where: {
      id: sourceConnectionId,
      provider: RepoProvider.GITEA,
      ...(actor.role === UserRole.ADMIN ? {} : { userId: actor.id }),
    },
    select: {
      id: true,
      baseUrl: true,
      tokenEncrypted: true,
      tokenExpiresAt: true,
      status: true,
      revokedAt: true,
    },
  });

  if (!connection) throw new PreflightError("SOURCE_CONNECTION_NOT_FOUND");
  if (connection.revokedAt || connection.status === SourceConnectionStatus.REVOKED || connection.status === SourceConnectionStatus.EXPIRED || (connection.tokenExpiresAt && connection.tokenExpiresAt <= new Date())) {
    throw new PreflightError("SOURCE_TOKEN_EXPIRED");
  }
  if (connection.status !== SourceConnectionStatus.ACTIVE || !connection.tokenEncrypted) {
    throw new PreflightError("SOURCE_TOKEN_INVALID");
  }

  const address = await validateSourceBaseUrl(connection.baseUrl);
  if (!address.ok) throw new PreflightError("UNSAFE_REPOSITORY_URL");
  try {
    return {
      connectionId: connection.id,
      baseUrl: canonicalBaseUrl(address.value),
      token: decryptSourceToken(connection.tokenEncrypted),
    };
  } catch {
    throw new PreflightError("SOURCE_TOKEN_INVALID");
  }
}
