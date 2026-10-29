import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { createDatasetShareLink, listDatasetShareLinks, ShareLinkError } from "@/lib/collaboration/share-link-service";
import { shareLinkCreateSchema } from "@/lib/validation/collaboration";
import { datasetIdSchema } from "@/lib/validation/dataset";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ datasetId: string }> };

function errorResponse(error: unknown) {
  if (!(error instanceof ShareLinkError)) throw error;
  if (error.code === "NOT_FOUND") return apiError(404, "GITEA_NOT_FOUND", "The dataset was not found.");
  if (error.code === "FORBIDDEN") return apiError(403, "FORBIDDEN", error.message);
  if (error.code === "LIMIT") return apiError(409, "SHARE_LINK_LIMIT", error.message);
  return apiError(400, "SHARE_LINK_INVALID", "This share link is not valid.");
}
async function input(context: Context) {
  const actor = await getRequestActor();
  if (!actor) return { response: apiError(401, "AUTH_REQUIRED", "Authentication is required.") } as const;
  const dataset = datasetIdSchema.safeParse((await context.params).datasetId);
  if (!dataset.success) return { response: apiError(400, "INVALID_REQUEST", "Dataset identifier is invalid.") } as const;
  return { actor, datasetId: dataset.data } as const;
}

export async function GET(_request: Request, context: Context) {
  const result = await input(context); if ("response" in result) return result.response;
  try { return apiSuccess({ items: await listDatasetShareLinks(result.actor, result.datasetId) }); } catch (error) { return errorResponse(error); }
}

/** The raw token is returned once, here; only its hash is stored. */
export async function POST(request: Request, context: Context) {
  const result = await input(context); if ("response" in result) return result.response;
  const parsed = shareLinkCreateSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return apiError(400, "INVALID_REQUEST", "Share link input is invalid.", parsed.error.flatten().fieldErrors);
  try {
    const created = await createDatasetShareLink(result.actor, { datasetId: result.datasetId, ...parsed.data });
    return apiSuccess(created, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
