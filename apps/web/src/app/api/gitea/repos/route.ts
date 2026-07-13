import { apiError, apiSuccess } from "@/lib/api-response";
import { giteaClient } from "@/lib/gitea";
import {
  canBrowseGitea,
  giteaErrorResponse,
  requireApiActor,
  zodFieldErrors,
} from "@/lib/gitea-route";
import { repositoryListQuerySchema } from "@/lib/validation/gitea";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireApiActor();
  if ("response" in auth) {
    return auth.response;
  }
  if (!canBrowseGitea(auth.actor)) {
    return apiError(403, "FORBIDDEN", "You cannot browse Gitea repositories.");
  }

  const url = new URL(request.url);
  const parsed = repositoryListQuerySchema.safeParse({
    page: url.searchParams.get("page") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });

  if (!parsed.success) {
    return apiError(
      400,
      "INVALID_REQUEST",
      "Repository pagination is invalid.",
      zodFieldErrors(parsed.error),
    );
  }

  try {
    const result = await giteaClient.listRepositories(parsed.data);
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
