import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { authRequired, isCrossOriginRequest } from "@/lib/authorization-response";
import { requireDatasetPermission } from "@/lib/authorization";
import { datasetIdSchema } from "@/lib/validation/dataset";
import { parseTextPolicy, resolveTextPolicy } from "@/lib/annotations/text-policy-service";
import { policyWriteSchema, readTextPolicy, writeTextPolicy } from "@/lib/annotations/text-policy-write-service";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ datasetId: string }> };

function writeFailureStatus(reason: string): 400 | 403 | 404 | 409 {
  if (reason === "NOT_FOUND") return 404;
  if (reason === "FORBIDDEN") return 403;
  if (reason === "INVALID_REQUEST") return 400;
  return 409; // REVISION_STALE, CONFLICT, DATASET_LOCKED, RECEIPT_CONFLICT, ...
}

export async function GET(_request: Request, context: Context) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const id = datasetIdSchema.safeParse((await context.params).datasetId);
  if (!id.success) return apiError(400, "INVALID_REQUEST", "Dataset identifier is invalid.");
  const access = await requireDatasetPermission(actor, id.data, "dataset.read");
  if (!access) return apiError(404, "GITEA_NOT_FOUND", "The dataset was not found.");
  if (access.forbidden) return apiError(403, "FORBIDDEN", "You do not have permission for this action.");

  const { dataset, labels } = await readTextPolicy(id.data);
  if (!dataset) return apiError(404, "GITEA_NOT_FOUND", "The dataset was not found.");
  const policy = parseTextPolicy(dataset.textPolicy);
  const resolved = resolveTextPolicy({ policy, labels });
  return apiSuccess({
    revision: dataset.textPolicyRevision,
    policy,
    eligible: {
      entityLabelIds: resolved.entityLabelIds,
      classificationGroups: resolved.classificationGroups,
      relationTypes: resolved.relationTypes,
    },
  });
}

export async function PUT(request: Request, context: Context) {
  if (isCrossOriginRequest(request)) return authRequired();
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const id = datasetIdSchema.safeParse((await context.params).datasetId);
  if (!id.success) return apiError(400, "INVALID_REQUEST", "Dataset identifier is invalid.");

  const body = await request.json().catch(() => null);
  const parsed = policyWriteSchema.safeParse(body);
  if (!parsed.success) return apiError(400, "INVALID_REQUEST", "Policy input is invalid.", parsed.error.flatten().fieldErrors);

  const result = await writeTextPolicy(actor, id.data, parsed.data);
  if (!result.ok) return apiError(writeFailureStatus(result.reason), "INVALID_REQUEST", "The TEXT policy could not be updated.");

  const { labels } = await readTextPolicy(id.data);
  const resolved = resolveTextPolicy({ policy: result.policy, labels });
  return apiSuccess({
    revision: result.revision,
    policy: result.policy,
    eligible: {
      entityLabelIds: resolved.entityLabelIds,
      classificationGroups: resolved.classificationGroups,
      relationTypes: resolved.relationTypes,
    },
  });
}
