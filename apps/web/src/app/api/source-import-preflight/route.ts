import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { readBoundedJsonRequest } from "@/lib/gitea-route";
import { safePreflightFailure } from "@/lib/providers/provider-errors";
import { preflightSourceImport } from "@/lib/source-import/preflight";
import { sourceImportPreflightSchema } from "@/lib/validation/source-connection";

export const dynamic = "force-dynamic";

/** Read-only source import preview. It does not create a Dataset, Job,
 * SourceConnection, queue delivery, or storage object. */
export async function POST(request: Request) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const body = await readBoundedJsonRequest(request);
  if (!body.success) return body.response;
  const parsed = sourceImportPreflightSchema.safeParse(body.data);
  if (!parsed.success) {
    return apiError(400, "INVALID_REQUEST", "The source import preview is invalid.", parsed.error.flatten().fieldErrors as Record<string, string[]>);
  }
  try {
    const preflight = await preflightSourceImport(actor, parsed.data);
    const actual = preflight.result.visibility;
    return apiSuccess({
      readyForImport: actual === parsed.data.repository.expectedVisibility,
      repository: {
        provider: "GITEA",
        fullName: `${preflight.result.repository.owner}/${preflight.result.repository.name}`,
        ref: preflight.result.ref.resolved,
        revision: preflight.result.ref.revision,
        rootPath: preflight.result.rootPath.normalized,
        visibility: actual,
      },
      assetPreview: preflight.result.assetPreview,
      visibility: { expected: parsed.data.repository.expectedVisibility, actual, matches: actual === parsed.data.repository.expectedVisibility },
    });
  } catch (error) {
    const safe = safePreflightFailure(error);
    return apiError(safe.status, safe.code === "PROVIDER_UNAVAILABLE" ? "SOURCE_PROVIDER_UNAVAILABLE" : safe.code, safe.message);
  }
}
