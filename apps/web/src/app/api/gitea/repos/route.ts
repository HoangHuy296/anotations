import { apiError, apiSuccess } from "@/lib/api-response";
import {
  giteaErrorResponse,
  requireOwnedGiteaClient,
  requireApiActor,
  zodFieldErrors,
} from "@/lib/gitea-route";
import { repositoryListQuerySchema, sourceConnectionQuerySchema } from "@/lib/validation/gitea";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireApiActor();
  if ("response" in auth) {
    return auth.response;
  }
  const url = new URL(request.url);
  const parsed = repositoryListQuerySchema.safeParse({
    page: url.searchParams.get("page") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });

  const source = sourceConnectionQuerySchema.safeParse({ sourceConnectionId: url.searchParams.get("sourceConnectionId") });
  if (!parsed.success) {
    return apiError(
      400,
      "INVALID_REQUEST",
      "Repository pagination is invalid.",
      zodFieldErrors(parsed.error),
    );
  }
  if (!source.success) return apiError(400, "INVALID_REQUEST", "A source connection is required.", zodFieldErrors(source.error));

  const gitea = await requireOwnedGiteaClient(auth.actor, source.data.sourceConnectionId);
  if (!gitea) return apiError(404, "GITEA_NOT_FOUND", "The requested source connection was not found.");

  try {
    const result = await gitea.client.listRepositories(parsed.data);
    return apiSuccess({
      items: result.repositories,
      pagination: {
        page: parsed.data.page,
        limit: parsed.data.limit,
        totalCount: result.totalCount,
      },
    });
  } catch (error: unknown) {
    return giteaErrorResponse(error);
  }
}
