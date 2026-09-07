import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import {
  AssetCommentError,
  enqueueCommentDispatches,
  resolveAssetComment,
} from "@/lib/collaboration/asset-comment-service";
import { collaborationRouteParamsSchema } from "@/lib/validation/collaboration";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ commentId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");

  const params = collaborationRouteParamsSchema.pick({ commentId: true }).safeParse(await context.params);
  if (!params.success || !params.data.commentId) {
    return apiError(400, "INVALID_REQUEST", "Comment identifier is invalid.");
  }

  try {
    const result = await resolveAssetComment(actor, params.data.commentId, false);
    await enqueueCommentDispatches(result);
    return apiSuccess({ id: result.commentId, resolved: false });
  } catch (error) {
    if (error instanceof AssetCommentError) {
      return error.code === "NOT_FOUND"
        ? apiError(404, "COLLABORATION_COMMENT_NOT_FOUND", "The comment was not found.")
        : apiError(403, "FORBIDDEN", error.message);
    }
    throw error;
  }
}
