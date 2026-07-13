import { apiError, apiSuccess } from "@/lib/api-response";
import { canImportDatasets } from "@/lib/auth";
import { persistDatasetImport } from "@/lib/dataset-import";
import { isDatabaseConfigured } from "@/lib/db";
import {
  findImageCandidates,
  giteaClient,
  MAX_IMPORT_IMAGES,
} from "@/lib/gitea";
import {
  giteaErrorResponse,
  readBoundedJsonRequest,
  requireApiActor,
  zodFieldErrors,
} from "@/lib/gitea-route";
import {
  importPreviewSchema,
  normalizeRepositoryPath,
} from "@/lib/validation/gitea";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = await requireApiActor();
  if ("response" in auth) {
    return auth.response;
  }
  if (!canImportDatasets(auth.actor)) {
    return apiError(
      403,
      "FORBIDDEN",
      "Reviewer or administrator access is required to import datasets.",
    );
  }

  const body = await readBoundedJsonRequest(request);
  if (!body.success) {
    return body.response;
  }

  const parsed = importPreviewSchema.safeParse(body.data);
  if (!parsed.success) {
    return apiError(
      400,
      "INVALID_REQUEST",
      "The import request is invalid.",
      zodFieldErrors(parsed.error),
    );
  }

  const rootPath = normalizeRepositoryPath(parsed.data.rootPath);
  if (rootPath === null) {
    return apiError(
      400,
      "INVALID_REQUEST",
      "The import root must be a safe repository-relative path.",
      { rootPath: ["Remove absolute or traversal path segments."] },
    );
  }

  try {
    const [repository, tree] = await Promise.all([
      giteaClient.getRepository(parsed.data.owner, parsed.data.repo),
      giteaClient.getTree(
        parsed.data.owner,
        parsed.data.repo,
        parsed.data.branch,
      ),
    ]);
    const images = findImageCandidates(tree, rootPath);
    const readyForPersistence =
      !tree.truncated &&
      images.length > 0 &&
      images.length <= MAX_IMPORT_IMAGES;

    if (parsed.data.mode === "persist") {
      if (!isDatabaseConfigured()) {
        return apiError(
          503,
          "INTERNAL_ERROR",
          "Database persistence is not configured.",
        );
      }
      if (tree.truncated) {
        return apiError(
          422,
          "INVALID_REQUEST",
          "The repository tree was truncated and cannot be imported safely.",
        );
      }
      if (images.length === 0) {
        return apiError(
          422,
          "INVALID_REQUEST",
          "No supported image files were found under the selected path.",
        );
      }
      if (images.length > MAX_IMPORT_IMAGES) {
        return apiError(
          422,
          "INVALID_REQUEST",
          `Imports are limited to ${MAX_IMPORT_IMAGES} images.`,
        );
      }

      try {
        const result = await persistDatasetImport({
          actor: auth.actor,
          repository,
          dataset: {
            name: parsed.data.name,
            branch: parsed.data.branch,
            rootPath,
          },
          images,
        });

        return apiSuccess(
          {
            mode: "persisted",
            ...result,
          },
          { status: 201 },
        );
      } catch (error: unknown) {
        console.error("Dataset import persistence failed.", error);
        return apiError(
          500,
          "INTERNAL_ERROR",
          "The dataset could not be persisted.",
        );
      }
    }

    return apiSuccess({
      mode: "preview",
      readyForPersistence,
      dataset: {
        name: parsed.data.name,
        branch: parsed.data.branch,
        rootPath,
      },
      repository,
      summary: {
        imageCount: images.length,
        totalBytes: images.reduce(
          (total, image) => total + (image.size ?? 0),
          0,
        ),
        treeTruncated: tree.truncated,
        importLimit: MAX_IMPORT_IMAGES,
      },
      images: images.slice(0, 100),
      imagePreviewTruncated: images.length > 100,
    });
  } catch (error: unknown) {
    return giteaErrorResponse(error);
  }
}
