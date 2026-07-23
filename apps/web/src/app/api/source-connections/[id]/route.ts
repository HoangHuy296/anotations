import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import {
  deleteSourceConnection,
  getSourceConnection,
} from "@/lib/source-connection-service";
import { sourceConnectionIdSchema } from "@/lib/validation/source-connection";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const parsed = sourceConnectionIdSchema.safeParse((await context.params).id);
  if (!parsed.success) {
    return apiError(404, "SOURCE_CONNECTION_NOT_FOUND", "The requested source connection was not found.");
  }
  const connection = await getSourceConnection(actor, parsed.data);
  if (!connection) {
    return apiError(404, "SOURCE_CONNECTION_NOT_FOUND", "The requested source connection was not found.");
  }
  return apiSuccess({ connection });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const parsed = sourceConnectionIdSchema.safeParse((await context.params).id);
  if (!parsed.success) return apiError(404, "SOURCE_CONNECTION_NOT_FOUND", "The requested source connection was not found.");
  const result = await deleteSourceConnection(actor, parsed.data);
  if (!result.ok) {
    if (result.code === "SOURCE_CONNECTION_IN_USE") return apiError(409, result.code, "The source connection is referenced by active work.");
    return apiError(404, result.code, "The requested source connection was not found.");
  }
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
