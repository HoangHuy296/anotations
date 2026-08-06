import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { readVideoAnnotations } from "@/lib/annotations/video-read-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ assetId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const url = new URL(request.url);
  const query = Object.fromEntries(url.searchParams.entries());
  if (query.limit) query.limit = Number(query.limit) as unknown as string;
  if (query.fromMs) query.fromMs = Number(query.fromMs) as unknown as string;
  if (query.toMs) query.toMs = Number(query.toMs) as unknown as string;
  const result = await readVideoAnnotations(actor, (await context.params).assetId, query);
  return result ? apiSuccess(result) : apiError(404, "ANNOTATION_NOT_FOUND", "The annotation resource was not found.");
}
