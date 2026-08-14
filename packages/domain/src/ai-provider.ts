/**
 * Pure, provider-agnostic contract for calling an external AI service. This
 * file must never import Prisma or issue a network call itself — it only
 * defines the shape a concrete adapter (worker-only, e.g.
 * apps/worker/src/providers/ai/aioz-company.provider.ts) implements, and the
 * shape the worker's job orchestration code (ai-submit.processor.ts,
 * ai-poll.processor.ts) programs against.
 *
 * apps/web never imports this module to construct or call an adapter; it
 * only ever reads AiModel columns from Postgres. See
 * specs/020-ai-integration/research.md #3 for the full rationale.
 */

export type AiProviderSubmitInput = {
  /** The durable AiTask id — safe, non-secret correlation identifier only. */
  aiTaskId: string;
  /** Asset ids submitted for this task, as recorded in AiTask.input.assetIds. */
  assetIds: string[];
  /** The stable AiModel.key the provider should run, not the internal AiModel.id. */
  modelKey: string;
};

export type AiProviderSubmitResult = {
  /** The provider's own task identifier; persisted as AiTask.externalTaskId. */
  externalTaskId: string;
};

/**
 * One normalized prediction, already converted from the provider's raw
 * response shape by the adapter's `normalizePredictions()`. `boundingBoxes`
 * is intentionally `unknown` until the real AIOZ-company contract defines
 * its coordinate format (pixel vs normalized, xyxy vs xywh);
 * ai-prediction-writer.ts turns it into Annotation.geometry.
 */
export type AiProviderPrediction = {
  assetId: string;
  labelKey: string;
  confidence: number;
  boundingBoxes: unknown;
};

/**
 * The provider's status check result, still carrying the *raw*,
 * not-yet-normalized completion payload. Callers must pass `rawPredictions`
 * through `adapter.normalizePredictions()` before treating anything as an
 * `AiProviderPrediction`.
 */
export type AiProviderStatusResult =
  | { status: "PENDING" | "IN_PROGRESS" }
  | { status: "COMPLETED"; rawPredictions: unknown }
  | { status: "FAILED"; error: { code: string; message: string } };

/**
 * Implemented once per external AI provider (worker-only). Resolved via
 * AiTask.modelId -> AiModel.provider -> this adapter, never via Job.provider.
 *
 * `submitTask`, `getTaskStatus`, and `normalizePredictions` are required —
 * every provider must be able to submit, poll, and translate its own raw
 * response shape into the normalized `AiProviderPrediction[]` shape.
 * `cancelTask` and `validateModel` are optional capabilities: not every
 * provider exposes an explicit cancel endpoint or a model-validation
 * endpoint, so callers must feature-detect (`if (adapter.cancelTask) ...`)
 * rather than assume they exist. Cancellation correctness never depends on
 * `cancelTask` being implemented — the poll processor already stops polling
 * once `Job.cancelRequestedAt` is set, regardless of this capability; a
 * provider-side `cancelTask` is a best-effort optimization on top of that.
 */
export interface AiProviderAdapter {
  submitTask(input: AiProviderSubmitInput): Promise<AiProviderSubmitResult>;
  getTaskStatus(externalTaskId: string): Promise<AiProviderStatusResult>;
  normalizePredictions(rawPredictions: unknown): AiProviderPrediction[];
  cancelTask?(externalTaskId: string): Promise<void>;
  validateModel?(modelKey: string): Promise<boolean>;
}
