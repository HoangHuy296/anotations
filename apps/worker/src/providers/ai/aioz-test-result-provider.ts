import { z } from "zod";

import type {
  AiProviderAdapter,
  AiProviderPrediction,
  AiProviderStatusResult,
  AiProviderSubmitInput,
  AiProviderSubmitResult,
} from "@fieldframe/domain/ai-provider";

/**
 * Test-only fake `AiProviderAdapter`, registered in `ai-provider-registry.ts`
 * under `AIOZ_TEST_RESULT_PROVIDER_KEY` -- never `"aioz-company"`, which is
 * reserved for the real, still-blocked T006 adapter (see that file's
 * `TODO(T006)`). Nothing about T006/`aioz-company` is touched here.
 *
 * Exists so the full submit -> registry resolution -> poll -> complete
 * pipeline (`ai-submit.processor.ts`, `ai-poll.processor.ts`,
 * `ai-prediction-writer.ts`) can be exercised end-to-end against a real
 * queue/worker without calling the real AIOZ-company API, which does not
 * exist yet. An integration test seeds an `AiModel` row with
 * `provider: AIOZ_TEST_RESULT_PROVIDER_KEY` to route through this adapter.
 */
export const AIOZ_TEST_RESULT_PROVIDER_KEY = "aioz-test-result";

/** The `Label.normalizedName` a completed task's prediction resolves against -- a test fixture must create a Label with this normalized name. */
export const TEST_LABEL_KEY = "aidetect";

/**
 * The deterministic `NormalizedBoundingBox` (`apps/web/src/types/image-workspace.ts`)
 * every completed task predicts. `ai-prediction-writer.ts` writes
 * `AiProviderPrediction.boundingBoxes` straight into `Annotation.geometry`
 * with no transformation (its own `TODO(T006)` -- normalization into the
 * canonical coordinate format is still pending the real provider's raw
 * shape), so this adapter's `normalizePredictions()` is what puts already-
 * canonical, directly renderable geometry on the wire.
 */
export const TEST_BOUNDING_BOX = { x: 0.25, y: 0.25, width: 0.2, height: 0.2 } as const;
export const TEST_CONFIDENCE = 0.69;

/** This adapter's own raw wire shape -- deliberately *not* `AiProviderPrediction`'s shape, so `normalizePredictions()` below does real field-mapping work rather than a formality passthrough, the same as a real adapter would for its provider's actual response body. */
const rawPredictionSchema = z.object({
  asset_id: z.string(),
  label_key: z.string(),
  score: z.number(),
  bbox: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
});
const rawPredictionsSchema = z.array(rawPredictionSchema);
type RawPrediction = z.infer<typeof rawPredictionSchema>;

type SubmittedTask = { assetIds: string[]; pollCount: number };

/**
 * Deterministic, in-memory, no-network fake. State is keyed by this
 * adapter's own `externalTaskId` (never a bare `AiTask.id`, matching a real
 * provider's boundary) and lives only for this worker process's lifetime --
 * fine for a test-only adapter that a real production `AiModel.provider`
 * value should never reference.
 *
 * `getTaskStatus` returns `IN_PROGRESS` on a submitted task's *first* status
 * check and `COMPLETED` from the second check onward, so a caller that polls
 * it exercises the real non-terminal -> terminal transition
 * (`ai-poll.processor.ts`'s PENDING/IN_PROGRESS branch) at least once,
 * instead of completing on the first poll.
 */
export class AiozTestResultProvider implements AiProviderAdapter {
  private readonly submitted = new Map<string, SubmittedTask>();

  async submitTask(input: AiProviderSubmitInput): Promise<AiProviderSubmitResult> {
    const externalTaskId = `test-result-${input.aiTaskId}`;
    this.submitted.set(externalTaskId, { assetIds: input.assetIds, pollCount: 0 });
    return { externalTaskId };
  }

  async getTaskStatus(externalTaskId: string): Promise<AiProviderStatusResult> {
    const task = this.submitted.get(externalTaskId);
    if (!task) return { status: "FAILED", error: { code: "AI_TEST_PROVIDER_UNKNOWN_TASK", message: "This fake provider has no record of this externalTaskId." } };

    task.pollCount += 1;
    if (task.pollCount === 1) return { status: "IN_PROGRESS" };

    const rawPredictions: RawPrediction[] = task.assetIds.map((assetId) => ({
      asset_id: assetId,
      label_key: TEST_LABEL_KEY,
      score: TEST_CONFIDENCE,
      bbox: { ...TEST_BOUNDING_BOX },
    }));
    return { status: "COMPLETED", rawPredictions };
  }

  normalizePredictions(rawPredictions: unknown): AiProviderPrediction[] {
    return rawPredictionsSchema.parse(rawPredictions).map((item) => ({
      assetId: item.asset_id,
      labelKey: item.label_key,
      confidence: item.score,
      boundingBoxes: item.bbox,
    }));
  }
}
