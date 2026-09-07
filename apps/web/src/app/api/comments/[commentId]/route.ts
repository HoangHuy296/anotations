import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import {
  AssetCommentError,
  deleteAssetComment,
  enqueueCommentDispatches,
  updateAssetComment,
} from "@/lib/collaboration/asset-comment-service";
import {
  assetCommentUpdateSchema,
  collaborationRouteParamsSchema,
} from "@/lib/validation/collaboration";

export const dynamic = "force-dynamic";

function commentError(error: unknown) {
  if (!(error instanceof AssetCommentError)) throw error;
  if (error.code === "NOT_FOUND") {
    return apiError(404, "COLLABORATION_COMMENT_NOT_FOUND", "The comment was not found.");
  }
  return apiError(403, "FORBIDDEN", error.message);
}

async function commentIdFrom(context: { params: Promise<{ commentId: string }> }) {
  const params = collaborationRouteParamsSchema.pick({ commentId: true }).safeParse(await context.params);
  return params.success && params.data.commentId ? params.data.commentId : null;
}

export async function PATCH(request: Request, context: { params: Promise<{ commentId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");

  const commentId = await commentIdFrom(context);
  const body = assetCommentUpdateSchema.safeParse(await request.json().catch(() => null));
  if (!commentId || !body.success) {
    return apiError(400, "INVALID_REQUEST", "Comment input is invalid.", body.success ? undefined : body.error.flatten().fieldErrors);
  }

  try {
    const result = await updateAssetComment(actor, commentId, body.data.body);
    await enqueueCommentDispatches(result);
    return apiSuccess({ id: result.commentId });
  } catch (error) {
    return commentError(error);
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ commentId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");

  const commentId = await commentIdFrom(context);
  if (!commentId) return apiError(400, "INVALID_REQUEST", "Comment identifier is invalid.");

  try {
    const result = await deleteAssetComment(actor, commentId);
    await enqueueCommentDispatches(result);
    return apiSuccess({ id: result.commentId });
  } catch (error) {
    return commentError(error);
  }
}
