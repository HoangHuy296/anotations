import { z } from "zod";

import { apiError } from "@/lib/api-response";
import { db, isDatabaseConfigured } from "@/lib/db";
import { giteaClient } from "@/lib/gitea";
import {
  giteaErrorResponse,
  requireApiActor,
} from "@/lib/gitea-route";
import { localStorageProvider } from "@/lib/storage/local-storage";

export const dynamic = "force-dynamic";

const imageIdSchema = z.string().cuid();

export async function GET(
  _request: Request,
  context: { params: Promise<{ imageId: string }> },
) {
  const auth = await requireApiActor();
  if ("response" in auth) {
    return auth.response;
  }

  const parsedId = imageIdSchema.safeParse((await context.params).imageId);
  if (!parsedId.success) {
    return apiError(400, "INVALID_REQUEST", "The image identifier is invalid.");
  }
  if (!isDatabaseConfigured()) {
    return apiError(503, "INTERNAL_ERROR", "Database access is not configured.");
  }

  const image = await db.asset.findFirst({
    where: { id: parsedId.data, modality: "IMAGE" },
    select: {
      id: true,
      sourcePath: true,
      mimeType: true,
      sourceFingerprint: true,
      dataset: {
        select: {
          sourceBranch: true,
          externalRepository: {
            select: {
              owner: true,
              repo: true,
              defaultBranch: true,
            },
          },
        },
      },
    },
  });

  if (!image) {
    return apiError(404, "GITEA_NOT_FOUND", "The image was not found.");
  }

  const sourcePath = image.sourcePath;
  const repository = image.dataset.externalRepository;
  const ref = image.dataset.sourceBranch ?? repository?.defaultBranch;
  if (!repository || !sourcePath || !ref) {
    return apiError(409, "GITEA_NOT_FOUND", "The image has no external source.");
  }

  const storageKey = `images/${image.id}/${image.sourceFingerprint}`;

  try {
    let bytes = await localStorageProvider.get(storageKey);
    let cacheStatus = "HIT";

    if (!bytes) {
      bytes = await giteaClient.getFileContent(
        repository.owner ?? "",
        repository.repo,
        sourcePath,
        ref,
      );
      await localStorageProvider.put(storageKey, bytes, image.mimeType);
      cacheStatus = "MISS";
    }

    return new Response(bytes, {
      headers: {
        "Cache-Control": "private, max-age=300",
        "Content-Length": String(bytes.byteLength),
        "Content-Type": image.mimeType,
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
        "X-Fieldframe-Cache": cacheStatus,
      },
    });
  } catch (error: unknown) {
    return giteaErrorResponse(error);
  }
}
