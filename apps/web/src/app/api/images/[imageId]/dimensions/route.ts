import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import { requireDatasetPermission } from "@/lib/authorization";
import { db, isDatabaseConfigured } from "@/lib/db";
import {
  readBoundedJsonRequest,
  requireApiActor,
  zodFieldErrors,
} from "@/lib/gitea-route";

export const dynamic = "force-dynamic";

const imageIdSchema = z.string().cuid();
const dimensionsSchema = z.object({
  width: z.number().int().min(1).max(100_000),
  height: z.number().int().min(1).max(100_000),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ imageId: string }> },
) {
  const auth = await requireApiActor();
  if ("response" in auth) {
    return auth.response;
  }

  const parsedId = imageIdSchema.safeParse((await context.params).imageId);
  const body = await readBoundedJsonRequest(request);
  if (!body.success) {
    return body.response;
  }
  const parsedBody = dimensionsSchema.safeParse(body.data);

  if (!parsedId.success || !parsedBody.success) {
    return apiError(
      400,
      "INVALID_REQUEST",
      "Image dimensions are invalid.",
      parsedBody.success ? undefined : zodFieldErrors(parsedBody.error),
    );
  }
  if (!isDatabaseConfigured()) {
    return apiError(503, "INTERNAL_ERROR", "Database access is not configured.");
  }

  const image = await db.asset.findFirst({ where: { id: parsedId.data, modality: "IMAGE", deletedAt: null }, select: { datasetId: true } });
  if (!image) return apiError(404, "GITEA_NOT_FOUND", "The image was not found.");
  const access = await requireDatasetPermission(auth.actor, image.datasetId, "dataset.update");
  if (!access || access.forbidden) return apiError(access?.forbidden ? 403 : 404, access?.forbidden ? "FORBIDDEN" : "GITEA_NOT_FOUND", "The image was not found.");
  const result = await db.asset.updateMany({
    where: {
      id: parsedId.data,
      modality: "IMAGE",
      OR: [
        { width: null },
        { height: null },
      ],
    },
    data: parsedBody.data,
  });

  return apiSuccess({
    updated: result.count === 1,
    dimensions: parsedBody.data,
  });
}
