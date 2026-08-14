import "server-only";

export type AiTaskErrorReason = "AI_MODEL_INACTIVE" | "AI_MODEL_NOT_FOUND" | "ASSET_NOT_IN_DATASET";

/** Typed failure for AI task creation/resolution — never thrown across the route boundary directly. */
export class AiTaskError extends Error {
  constructor(readonly reason: AiTaskErrorReason) {
    super(reason);
    this.name = "AiTaskError";
  }
}
