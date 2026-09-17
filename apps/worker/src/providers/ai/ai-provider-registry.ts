import type { AiProviderAdapter } from "@annotationplatform/domain/ai-provider";

import { AIOZ_TEST_RESULT_PROVIDER_KEY, AiozTestResultProvider } from "./aioz-test-result-provider.js";
import { AIOZ_ANNOTATION_SERVICES_PROVIDER_KEY, AiozAnnotationServicesProvider } from "./aioz-annotation-services-provider.js";
import { createAiozTaskResources } from "./aioz-task-resources.js";
import { getAiozAnnotationServicesConfig } from "../../config.js";
import type { AiTask, PrismaClient } from "../../../../../lib/generated/prisma/client.js";

export type AiProviderResolutionReason = "AI_MODEL_INACTIVE" | "AI_MODEL_NOT_FOUND" | "AI_PROVIDER_NOT_REGISTERED";

/** Typed, worker-local failure — never a raw Error message crosses back into a Job/AiTask field. */
export class AiProviderResolutionError extends Error {
  constructor(readonly reason: AiProviderResolutionReason) {
    super(reason);
    this.name = "AiProviderResolutionError";
  }
}

/**
 * Keyed by AiModel.provider (a plain string column, e.g. "aioz-company") —
 * never by Job.provider, which is an unrelated RepoProvider enum used only
 * by the repository-import flow.
 *
 * The real aioz-company entry is constructed lazily with worker resources
 * below, so missing optional AI credentials never break other Job types.
 *
 * `AIOZ_TEST_RESULT_PROVIDER_KEY` is a distinct, test-only entry
 * (aioz-test-result-provider.ts) that lets an integration test exercise this
 * entire resolution/submit/poll pipeline against a real queue/worker without
 * the real adapter above — no production `AiModel` row
 * should ever carry that provider value. Excluded outright when
 * NODE_ENV=production, so a real deployment can never resolve it even if one
 * did.
 */
const providers: Record<string, AiProviderAdapter> = {
  ...(process.env.NODE_ENV !== "production" ? { [AIOZ_TEST_RESULT_PROVIDER_KEY]: new AiozTestResultProvider() } : {}),
};

/**
 * Resolves the AiProviderAdapter for a given AiTask, strictly via
 * AiTask.modelId -> AiModel.provider. Must never select or reference
 * Job.provider (see AGENTS.md / research.md #3).
 */
export async function resolveAiProviderForTask(
  db: PrismaClient,
  aiTask: Pick<AiTask, "modelId">,
  registry?: Record<string, AiProviderAdapter>,
): Promise<AiProviderAdapter> {
  const model = await db.aiModel.findUnique({
    where: { id: aiTask.modelId },
    select: { provider: true, isActive: true },
  });
  if (!model) throw new AiProviderResolutionError("AI_MODEL_NOT_FOUND");
  if (!model.isActive) throw new AiProviderResolutionError("AI_MODEL_INACTIVE");
  if (!registry && model.provider === AIOZ_ANNOTATION_SERVICES_PROVIDER_KEY) {
    return new AiozAnnotationServicesProvider(getAiozAnnotationServicesConfig(), createAiozTaskResources(db));
  }
  const adapter = (registry ?? providers)[model.provider];
  if (!adapter) throw new AiProviderResolutionError("AI_PROVIDER_NOT_REGISTERED");
  return adapter;
}
