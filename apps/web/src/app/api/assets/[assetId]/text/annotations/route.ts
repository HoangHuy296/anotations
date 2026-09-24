import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { isCrossOriginRequest } from "@/lib/authorization-response";
import { submitTextAnnotationCommand } from "@/lib/annotations/text-span-service";
import { readTextAnnotationPage } from "@/lib/annotations/text-annotation-read-service";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ assetId: string }> };

function failure(reason: string) {
  const status = reason === "NOT_FOUND" ? 404 : reason === "FORBIDDEN" ? 403 : reason === "INVALID_REQUEST" ? 400 : reason === "INVALID_RANGE" || reason === "LIMIT_EXCEEDED" ? 422 : 409;
  return apiError(status, status === 404 ? "ANNOTATION_NOT_FOUND" : status === 409 ? "ANNOTATION_REVISION_CONFLICT" : "INVALID_REQUEST", "The text annotation could not be saved or loaded.", undefined, undefined, { reason });
}

export async function GET(request: Request, context: Context) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const cursor = new URL(request.url).searchParams.get("cursor");
  if (cursor && cursor.length > 1024) return failure("INVALID_REQUEST");
  const result = await readTextAnnotationPage(actor, (await context.params).assetId, cursor);
  return result.ok ? apiSuccess(result.data) : failure(result.reason);
}

export async function POST(request: Request, context: Context) {
  if (isCrossOriginRequest(request)) return apiError(403, "FORBIDDEN", "Cross-origin writes are not allowed.");
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const input = await request.json().catch(() => null);
  const commandKind = input && typeof input === "object" && "command" in input ? (input as { command?: { kind?: unknown } }).command?.kind : undefined;
  const isCreate = commandKind === "createSpan" || commandKind === "createRelation";
  const result = await submitTextAnnotationCommand(actor, (await context.params).assetId, input);
  return result.ok ? apiSuccess(result.result, { status: !result.replayed && isCreate ? 201 : 200 }) : failure(result.reason);
}
