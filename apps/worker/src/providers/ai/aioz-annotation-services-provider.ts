import { createHash } from "node:crypto";
import { z } from "zod";

import { classifyAiProviderStatus } from "@annotationplatform/domain/ai-batch";
import type { AiProviderAdapter, AiProviderPrediction, AiProviderStatusResult, AiProviderSubmitInput, AiProviderSubmitResult } from "@annotationplatform/domain/ai-provider";
import type { AiozAnnotationServicesConfig } from "../../config.js";
import { AiozResultError, normalizeAiozOutput, type AiozImageAssociation } from "./aioz-annotation-services-normalization.js";

import { normalizeAiozVideoOutput } from "./aioz-video-normalization.js";

export const AIOZ_ANNOTATION_SERVICES_PROVIDER_KEY = "aioz-company";
export const digestAiozImageUrl = (url: string) => createHash("sha256").update(url).digest("hex");

export class AiozProviderError extends Error {
  constructor(readonly code: string) { super(code); this.name = "AiozProviderError"; }
}

export type AiozSubmittedImage = { assetId: string; urlDigest: string; mediaType?: "image" | "video" };
export type AiozPreparedSubmission = { externalTaskId: string } | {
  modelId: string;
  mediaType: "image" | "video";
  taskName: "detection" | "tracking";
  images: AiozImageAssociation[];
  options?: { classes?: string[]; confidence_threshold?: number; iou_threshold?: number };
};

/** Prisma/MinIO integration stays behind worker-local resource operations. */
export interface AiozTaskResources {
  prepare(input: AiProviderSubmitInput): Promise<AiozPreparedSubmission>;
  recordSubmission(aiTaskId: string, externalTaskId: string): Promise<void>;
  loadImages(externalTaskId: string): Promise<AiozSubmittedImage[]>;
}

// The deployed service also emits `failed_system` (verification/provider-contract.md F3); statuses are
// classified by an explicit allowlist (classifyAiProviderStatus) instead of a closed enum.
const status = z.string();
const created = z.object({ success: z.boolean().default(true), data: z.object({ task_id: z.string().uuid(), status, created_at: z.string() }) });
const result = z.object({ success: z.boolean().default(true), data: z.object({ task_id: z.string().uuid(), status, output: z.array(z.unknown()).nullable(), error: z.string().nullable() }) });
const request = z.object({
  type: z.enum(["image", "video"]), task_name: z.enum(["detection", "tracking"]),
  files: z.array(z.string().url()).min(1), model_id: z.string().uuid(),
  classes: z.array(z.string().min(1)).optional(), confidence_threshold: z.number().min(0).max(1).optional(), iou_threshold: z.number().min(0).max(1).optional(),
}).strict();
const normalizedInput = z.object({ mediaType: z.enum(["image", "video"]).default("image"), output: z.unknown(), images: z.array(z.object({ assetId: z.string(), imageUrl: z.string() })) });

/** One HTTP call per submit/poll; scheduling/cancellation remain in the Job pipeline. */
export class AiozAnnotationServicesProvider implements AiProviderAdapter {
  constructor(private readonly config: AiozAnnotationServicesConfig, private readonly resources: AiozTaskResources, private readonly http: typeof fetch = fetch) {}

  async submitTask(input: AiProviderSubmitInput): Promise<AiProviderSubmitResult> {
    try {
      const prepared = await this.resources.prepare(input);
      if ("externalTaskId" in prepared) return { externalTaskId: prepared.externalTaskId };
      const body = request.safeParse({ type: prepared.mediaType, task_name: prepared.taskName, files: prepared.images.map((image) => image.imageUrl), model_id: prepared.modelId, ...prepared.options });
      if (!body.success) throw new AiozProviderError("AIOZ_INVALID_INPUT");
      const parsed = created.safeParse(await this.call("/api/v1/tasks/create", { method: "POST", body: JSON.stringify(body.data) }));
      if (!parsed.success) throw new AiozProviderError("AIOZ_INVALID_CREATE_RESPONSE");
      // A task id exists once the service accepted the request: record it whatever the status, so
      // an unexpected status can never orphan an already-created (non-idempotent) external task.
      if (!parsed.data.success || classifyAiProviderStatus(parsed.data.data.status) === "FAILED") throw new AiozProviderError("AIOZ_EXTERNAL_FAILED");
      const externalTaskId = parsed.data.data.task_id;
      await this.resources.recordSubmission(input.aiTaskId, externalTaskId);
      return { externalTaskId };
    } catch (error) { throw this.safeError(error); }
  }

  async getTaskStatus(externalTaskId: string): Promise<AiProviderStatusResult> {
    try {
      if (!z.string().uuid().safeParse(externalTaskId).success) throw new AiozProviderError("AIOZ_INVALID_TASK_ID");
      const parsed = result.safeParse(await this.call(`/api/v1/tasks/result/${encodeURIComponent(externalTaskId)}`, { method: "GET" }));
      if (!parsed.success || parsed.data.data.task_id !== externalTaskId) throw new AiozProviderError("AIOZ_INVALID_RESULT_RESPONSE");
      const data = parsed.data.data;
      const statusClass = classifyAiProviderStatus(data.status);
      if (!parsed.data.success || statusClass === "FAILED") throw new AiozProviderError("AIOZ_EXTERNAL_FAILED");
      if (statusClass === "UNKNOWN") throw new AiozProviderError("AIOZ_STATUS_UNKNOWN");
      // Decision D-FS: `failed_system` is non-terminal and not assumed recoverable; its error text is never read.
      if (statusClass === "DEGRADED") return { status: "IN_PROGRESS", degraded: true };
      if (data.error !== null) throw new AiozProviderError("AIOZ_EXTERNAL_FAILED");
      if (statusClass === "PENDING") return { status: "PENDING" };
      if (statusClass === "IN_PROGRESS") return { status: "IN_PROGRESS" };
      const submitted = await this.resources.loadImages(externalTaskId);
      if (!data.output || data.output.length !== submitted.length || !submitted.length) throw new AiozProviderError("AIOZ_INVALID_OUTPUT");
      const byDigest = new Map(submitted.map((image) => [image.urlDigest, image.assetId]));
      if (byDigest.size !== submitted.length) throw new AiozProviderError("AIOZ_ASSET_ASSOCIATION_INVALID");
      const mediaType = submitted[0].mediaType ?? "image";
      if (submitted.some((item) => (item.mediaType ?? "image") !== mediaType)) throw new AiozProviderError("AIOZ_ASSET_ASSOCIATION_INVALID");
      const images = data.output.map((output) => {
        const path = z.object({ image_path: z.string().url().optional(), video_path: z.string().url().optional() }).safeParse(output);
        const url = path.success ? (mediaType === "video" ? path.data.video_path : path.data.image_path) : undefined;
        const assetId = url ? byDigest.get(digestAiozImageUrl(url)) : undefined;
        if (!assetId || !url) throw new AiozProviderError("AIOZ_ASSET_ASSOCIATION_INVALID");
        return { assetId, imageUrl: url };
      });
      const rawPredictions = { output: data.output, images, mediaType };
      // Fail malformed provider output here, so the existing poller finalizes
      // FAILED instead of repeatedly throwing or persisting empty predictions.
      this.normalizePredictions(rawPredictions);
      return { status: "COMPLETED", rawPredictions };
    } catch (error) {
      const safe = this.safeError(error);
      return { status: "FAILED", error: { code: safe.code, message: "AIOZ annotation request failed." } };
    }
  }

  normalizePredictions(rawPredictions: unknown): AiProviderPrediction[] {
    const parsed = normalizedInput.safeParse(rawPredictions);
    if (!parsed.success) throw new AiozProviderError("AIOZ_INVALID_OUTPUT");
    return parsed.data.mediaType === "video" ? normalizeAiozVideoOutput(parsed.data.output, parsed.data.images) : normalizeAiozOutput(parsed.data.output, parsed.data.images);
  }

  private safeError(error: unknown): AiozProviderError {
    if (error instanceof AiozProviderError) return error;
    if (error instanceof AiozResultError) return new AiozProviderError(error.code);
    return new AiozProviderError("AIOZ_RESOURCE_FAILED");
  }

  private async call(path: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.http(new URL(path, this.config.baseUrl), {
        ...init, signal: controller.signal, redirect: "error",
        headers: { "Content-Type": "application/json", "API-Key": this.config.apiKey },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new AiozProviderError(response.status >= 500 ? "AIOZ_HTTP_5XX" : "AIOZ_HTTP_4XX");
      }
      // Bound both response time and memory. Raw provider bodies never reach logs.
      const reader = response.body?.getReader();
      if (!reader) throw new AiozProviderError("AIOZ_INVALID_RESPONSE");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new AiozProviderError("AIOZ_RESPONSE_TOO_LARGE"); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new AiozProviderError("AIOZ_INVALID_RESPONSE"); }
    } catch (error) {
      if (error instanceof AiozProviderError) throw error;
      throw new AiozProviderError(controller.signal.aborted ? "AIOZ_TIMEOUT" : "AIOZ_NETWORK_ERROR");
    } finally { clearTimeout(timer); }
  }
}
