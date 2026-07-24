import { NextResponse } from "next/server";

import { apiError } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { readBoundedJsonRequest } from "@/lib/gitea-route";
import { safePreflightFailure } from "@/lib/providers/provider-errors";
import { preflightRepository } from "@/lib/providers/preflight-repository";
import { repositoryPreflightSchema } from "@/lib/validation/repository-preflight";

export const dynamic = "force-dynamic";

function hasUnsupportedProvider(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const provider = (value as { provider?: unknown }).provider;
  return typeof provider === "string" && provider !== "GITHUB" && provider !== "GITEA";
}

function safeSuccess(preflight: Awaited<ReturnType<typeof preflightRepository>>) {
  return NextResponse.json(
    { preflight },
    { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  );
}

export async function POST(request: Request) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");

  const body = await readBoundedJsonRequest(request);
  if (!body.success) return body.response;
  // Keep a documented stable category for an explicit provider selection.
  // Other malformed fields still take the strict-schema INVALID_REQUEST path.
  if (hasUnsupportedProvider(body.data)) {
    return apiError(400, "UNSUPPORTED_PROVIDER", "The selected repository provider is not supported.");
  }
  const parsed = repositoryPreflightSchema.safeParse(body.data);
  if (!parsed.success) {
    return apiError(400, "INVALID_REQUEST", "The repository preflight request is invalid.");
  }

  try {
    return safeSuccess(await preflightRepository(actor, parsed.data));
  } catch (error) {
    const safe = safePreflightFailure(error);
    return apiError(
      safe.status,
      safe.code === "PROVIDER_UNAVAILABLE" ? "SOURCE_PROVIDER_UNAVAILABLE" : safe.code,
      safe.message,
    );
  }
}
