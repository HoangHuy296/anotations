import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { revokeDatasetShareLink, ShareLinkError } from "@/lib/collaboration/share-link-service";
import { datasetIdSchema } from "@/lib/validation/dataset";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ datasetId: string; linkId: string }> };

export async function DELETE(_request: Request, context: Context) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const params = await context.params;
  const datasetId = datasetIdSchema.safeParse(params.datasetId);
  const linkId = z.string().cuid().safeParse(params.linkId);
  if (!datasetId.success || !linkId.success) return apiError(400, "INVALID_REQUEST", "Identifier is invalid.");
  try {
    return apiSuccess(await revokeDatasetShareLink(actor, { datasetId: datasetId.data, linkId: linkId.data }));
  } catch (error) {
    if (!(error instanceof ShareLinkError)) throw error;
    if (error.code === "FORBIDDEN") return apiError(403, "FORBIDDEN", error.message);
    return apiError(404, "GITEA_NOT_FOUND", "The share link was not found.");
  }
}
