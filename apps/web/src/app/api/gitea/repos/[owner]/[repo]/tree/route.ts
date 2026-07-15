import { apiError, apiSuccess } from "@/lib/api-response";
import {
  giteaErrorResponse,
  requireOwnedGiteaClient,
  requireApiActor,
  zodFieldErrors,
} from "@/lib/gitea-route";
import {
  normalizeRepositoryPath,
  repositoryParamsSchema,
  sourceConnectionQuerySchema,
  treeQuerySchema,
} from "@/lib/validation/gitea";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ owner: string; repo: string }> },
) {
  const auth = await requireApiActor();
  if ("response" in auth) {
    return auth.response;
  }
  const params = repositoryParamsSchema.safeParse(await context.params);
  const url = new URL(request.url);
  const query = treeQuerySchema.safeParse({
    ref: url.searchParams.get("ref") ?? undefined,
    path: url.searchParams.get("path") ?? undefined,
  });
  const source = sourceConnectionQuerySchema.safeParse({ sourceConnectionId: url.searchParams.get("sourceConnectionId") });

  if (!params.success || !query.success || !source.success) {
    return apiError(
      400,
      "INVALID_REQUEST",
      "The repository tree request is invalid.",
      {
        ...(params.success ? {} : zodFieldErrors(params.error)),
        ...(query.success ? {} : zodFieldErrors(query.error)),
      },
    );
  }

  const rootPath = normalizeRepositoryPath(query.data.path);
  if (rootPath === null) {
    return apiError(
      400,
      "INVALID_REQUEST",
      "The repository path must be relative and cannot contain traversal segments.",
      { path: ["Enter a safe repository-relative path."] },
    );
  }

  const gitea = await requireOwnedGiteaClient(auth.actor, source.data.sourceConnectionId);
  if (!gitea) return apiError(404, "GITEA_NOT_FOUND", "The requested source connection was not found.");

  try {
    const tree = await gitea.client.getTree(
      params.data.owner,
      params.data.repo,
      query.data.ref,
    );
    const prefix = rootPath ? `${rootPath}/` : "";
    const entries = tree.entries.filter(
      (entry) =>
        !rootPath ||
        entry.path === rootPath ||
        entry.path.startsWith(prefix),
    );

    return apiSuccess({
      repository: {
        owner: params.data.owner,
        name: params.data.repo,
        ref: query.data.ref,
        rootPath,
      },
      sha: tree.sha,
      truncated: tree.truncated,
      entries,
    });
  } catch (error: unknown) {
    return giteaErrorResponse(error);
  }
}
