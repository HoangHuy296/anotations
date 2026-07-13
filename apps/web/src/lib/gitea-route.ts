import "server-only";

import { UserRole } from "@internal/db";
import type { ZodError } from "zod";

import { apiError } from "@/lib/api-response";
import { getRequestActor, type RequestActor } from "@/lib/auth";
import { GiteaClientError } from "@/lib/gitea";

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

export function canBrowseGitea(actor: RequestActor) {
  const browsableRoles = new Set<UserRole>([
    UserRole.ADMIN,
    UserRole.REVIEWER,
    UserRole.LABELER,
  ]);

  return browsableRoles.has(actor.role);
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
