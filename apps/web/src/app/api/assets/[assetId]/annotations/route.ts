import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { mutateImageAnnotations, readAssetAnnotations } from "@/lib/annotations/annotation-service";
import { annotationChangeSetSchema } from "@/lib/validation/annotation-api";

export const dynamic = "force-dynamic";

function failure(reason: "NOT_FOUND" | "FORBIDDEN" | "INVALID_REQUEST" | "CONFLICT" | "WRITE_UNSUPPORTED" | "CREATE_REPLAY_CONFLICT") {
  if (reason === "NOT_FOUND") return apiError(404, "ANNOTATION_NOT_FOUND", "The annotation resource was not found.");
  if (reason === "FORBIDDEN") return apiError(403, "FORBIDDEN", "You do not have permission for this action.");
  if (reason === "CONFLICT") return apiError(409, "ANNOTATION_REVISION_CONFLICT", "An annotation changed. Reload before saving.");
  if (reason === "WRITE_UNSUPPORTED") return apiError(422, "ANNOTATION_WRITE_UNSUPPORTED_FOR_MODALITY", "Annotation writes are not supported for this asset modality.");
  if (reason === "CREATE_REPLAY_CONFLICT") return apiError(409, "ANNOTATION_CREATE_REPLAY_CONFLICT", "The create replay identity conflicts with an existing annotation.");
  return apiError(400, "INVALID_REQUEST", "The annotation request is invalid.");
}

export async function GET(_: Request, context: { params: Promise<{ assetId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const result = await readAssetAnnotations(actor, (await context.params).assetId);
  return result.ok ? apiSuccess({ annotations: result.value }) : failure(result.reason);
}

export async function PUT(request: Request, context: { params: Promise<{ assetId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const body = await request.json().catch(() => null);
  const parsed = annotationChangeSetSchema.safeParse(body);
  if (!parsed.success) return failure("INVALID_REQUEST");
  const result = await mutateImageAnnotations(actor, (await context.params).assetId, parsed.data);
  return result.ok ? apiSuccess({ annotations: result.value }) : failure(result.reason);
}
