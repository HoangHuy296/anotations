import "server-only";

import type { ZodError } from "zod";

import { apiError } from "@/lib/api-response";
import { requireOwnedSourceConnection, resolveDatasetSourceConnection } from "@/lib/authorization";
import { getRequestActor, type RequestActor } from "@/lib/auth";
import { decryptSourceToken } from "@/lib/source-connection-crypto";
import { createGiteaClient, GiteaClientError } from "@/lib/gitea";

export async function requireApiActor(): Promise<
  { actor: RequestActor } | { response: Response }
> {
  const actor = await getRequestActor();

  if (!actor) {
    return {
      response: apiError(
        401,
        "AUTH_REQUIRED",
        "A recognized application user is required.",
      ),
    };
  }

  return { actor };
}

export async function requireOwnedGiteaClient(actor: RequestActor, sourceConnectionId: string) {
  const connection = await requireOwnedSourceConnection(actor, sourceConnectionId);
  if (!connection || !connection.tokenEncrypted) return null;

  try {
    const token = decryptSourceToken(connection.tokenEncrypted);
    return {
      connection: { id: connection.id, baseUrl: connection.baseUrl },
      client: createGiteaClient({ baseUrl: connection.baseUrl, token }),
    };
  } catch {
    // Never disclose whether the stored ciphertext/key is malformed to callers.
    return null;
  }
}

/**
 * Resolves the dataset-selected connection only after dataset authorization.
 * It is intentionally server-only and returns no connection data to browsers.
 */
export async function requireDatasetGiteaClient(datasetId: string) {
  const dataset = await resolveDatasetSourceConnection(datasetId);
  const connection = dataset?.sourceConnection;
  if (!connection?.tokenEncrypted) return null;

  try {
    return createGiteaClient({
      baseUrl: connection.baseUrl,
      token: decryptSourceToken(connection.tokenEncrypted),
    });
  } catch {
    return null;
  }
}

export function zodFieldErrors(error: ZodError) {
  return error.flatten().fieldErrors as Record<string, string[]>;
}

export function giteaErrorResponse(error: unknown) {
  if (error instanceof GiteaClientError) {
    switch (error.kind) {
      case "configuration":
        return apiError(
          503,
          "GITEA_CONFIGURATION_ERROR",
          "Gitea integration is not configured.",
        );
      case "not_found":
        return apiError(
          404,
          "GITEA_NOT_FOUND",
          "The requested repository resource was not found.",
        );
      case "rate_limited":
        return apiError(
          429,
          "GITEA_RATE_LIMITED",
          "Gitea is temporarily rate limiting requests.",
        );
      case "invalid_response":
        return apiError(
          502,
          "GITEA_RESPONSE_INVALID",
          "Gitea returned an invalid response.",
        );
      case "unavailable":
        return apiError(
          502,
          "GITEA_UNAVAILABLE",
          "Gitea is currently unavailable.",
        );
    }
  }

  console.error("Unexpected Gitea route failure.", error);
  return apiError(500, "INTERNAL_ERROR", "The request could not be completed.");
}

export async function readBoundedJsonRequest(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 16_384) {
    return {
      success: false as const,
      response: apiError(
        413,
        "INVALID_REQUEST",
        "The request body is too large.",
      ),
    };
  }

  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > 16_384) {
    return {
      success: false as const,
      response: apiError(
        413,
        "INVALID_REQUEST",
        "The request body is too large.",
      ),
    };
  }

  try {
    return {
      success: true as const,
      data: JSON.parse(text) as unknown,
    };
  } catch {
    return {
      success: false as const,
      response: apiError(
        400,
        "INVALID_REQUEST",
        "The request body must contain valid JSON.",
      ),
    };
  }
}
