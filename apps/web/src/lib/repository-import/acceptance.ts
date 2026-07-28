import "server-only";

import type { RequestActor } from "@/lib/auth";
import { canCreateDataset } from "@/lib/authorization";
import { createAndEnqueueNewDatasetSourceImportJob } from "@/lib/queue/enqueue-job";
import { preflightRepository } from "@/lib/providers/preflight-repository";
import type { PreflightResult } from "@/lib/providers/provider.types";
import { preflightSourceImport } from "@/lib/source-import/preflight";
import { normalizeSourceRootPath } from "@/lib/source-access-policy";
import {
  creationRequestHash,
  type RepositoryImportAcceptance,
} from "@/lib/repository-import/types";
import type { RepositoryImportRequest } from "@/lib/validation/repository-import-request";

type RepositoryPreflight = { result: PreflightResult; baseUrl: string };

function safePreviewAggregates(result: PreflightResult) {
  // The full manifest is never persisted. A non-truncated preview supplies
  // only bounded aggregate limits; `{0,0}` means the worker applies its own
  // immutable policy cap when a provider cannot supply an aggregate.
  const preview = result.assetPreview;
  if (!preview || preview.truncated) return { itemCount: 0, declaredBytes: 0 };
  return { itemCount: preview.detectedAssetCount, declaredBytes: preview.detectedBytes };
}

export type RepositoryImportAcceptanceFailure =
  | { ok: false; status: 403; code: "FORBIDDEN" }
  | { ok: false; status: 409; code: "IDEMPOTENCY_KEY_CONFLICT" | "JOB_CONFLICT" }
  | { ok: false; status: 404; code: "SOURCE_CONNECTION_NOT_FOUND" }
  | { ok: false; status: 422; code: "SOURCE_IMPORT_LIMIT_EXCEEDED" }
  | { ok: false; status: 422; code: "ONE_TIME_PAT_REQUIRES_SAVE_FOR_ASYNC_IMPORT" }
  | { ok: false; status: 400; code: "INVALID_REQUEST" };

export type RepositoryImportAcceptanceResult =
  | { ok: true; acceptance: RepositoryImportAcceptance; deliveryPending: boolean }
  | RepositoryImportAcceptanceFailure;

/**
 * Reuses the Phase-014 read-only coordinator. The one-time PAT is retained in
 * this server call stack only; no durable write happens until the shared
 * Dataset/Job transaction below has completed the repeat preflight.
 */
async function preflightForRepositoryImport(
  actor: RequestActor,
  request: RepositoryImportRequest,
): Promise<RepositoryPreflight> {
  if (request.provider === "GITEA") {
    const source = await preflightSourceImport(actor, {
      provider: "GITEA",
      datasetName: request.datasetName,
      credentialMode: request.credentialMode,
      ...(request.credentialMode === "EXISTING_SOURCE_CONNECTION"
        ? { sourceConnectionId: request.sourceConnectionId! }
        : { serverUrl: request.serverUrl! }),
      ...(request.credentialMode === "ONE_TIME_PAT"
        ? {
          personalAccessToken: request.personalAccessToken!,
          saveAsSourceConnection: request.saveAsSourceConnection,
          connectionName: request.connectionName,
        }
        : {}),
      repository: {
        owner: request.repository.owner,
        repo: request.repository.name,
        ref: request.repository.ref,
        rootPath: request.repository.rootPath,
        expectedVisibility: request.repository.expectedVisibility,
      },
    });
    return { result: source.result, baseUrl: source.baseUrl };
  }

  const result = await preflightRepository(actor, {
    provider: "GITHUB",
    repository: { owner: request.repository.owner, name: request.repository.name },
    ref: request.repository.ref,
    rootPath: request.repository.rootPath,
  });
  return { result, baseUrl: "" };
}

/**
 * The one Phase-015 durable acceptance coordinator. Preflight is complete
 * before this function asks the shared serializable Dataset/Job transaction to
 * persist anything; queue delivery remains strictly post-commit in that
 * boundary.
 */
export async function acceptRepositoryImportRequest(
  actor: RequestActor,
  request: RepositoryImportRequest,
): Promise<RepositoryImportAcceptanceResult> {
  if (!canCreateDataset(actor)) return { ok: false, status: 403, code: "FORBIDDEN" };

  if (request.credentialMode === "ONE_TIME_PAT" && request.saveAsSourceConnection !== true) {
    return { ok: false, status: 422, code: "ONE_TIME_PAT_REQUIRES_SAVE_FOR_ASYNC_IMPORT" };
  }

  const root = normalizeSourceRootPath(request.repository.rootPath ?? "");
  if (!root.ok) return { ok: false, status: 400, code: "INVALID_REQUEST" };

  const preflight = await preflightForRepositoryImport(actor, request);
  if (preflight.result.visibility !== request.repository.expectedVisibility) {
    return { ok: false, status: 400, code: "INVALID_REQUEST" };
  }

  const accepted = await createAndEnqueueNewDatasetSourceImportJob(actor, {
    datasetName: request.datasetName,
    creationIdempotency: {
      key: request.idempotencyKey,
      requestHash: creationRequestHash(
        request,
        root.value || null,
        request.credentialMode === "EXISTING_SOURCE_CONNECTION" ? null : preflight.baseUrl,
      ),
    },
    sourceConnection: request.credentialMode === "EXISTING_SOURCE_CONNECTION" && request.sourceConnectionId
      ? { id: request.sourceConnectionId, baseUrl: preflight.baseUrl }
      : null,
    createSourceConnection: request.credentialMode === "ONE_TIME_PAT"
      ? {
        name: request.connectionName!,
        baseUrl: preflight.baseUrl,
        token: request.personalAccessToken!,
      }
      : null,
    repository: {
      provider: request.provider,
      // Credentialed source imports re-resolve their address from PostgreSQL;
      // public GitHub uses server configuration in the later worker phase.
      baseUrl: preflight.baseUrl,
      owner: preflight.result.repository.owner,
      repo: preflight.result.repository.name,
      ref: preflight.result.ref.resolved,
      normalizedRootPath: root.value,
      visibility: preflight.result.visibility,
    },
    manifest: safePreviewAggregates(preflight.result),
  });

  if (!accepted.ok) {
    if (accepted.status === 409 && "reason" in accepted && accepted.reason === "IDEMPOTENCY_KEY_CONFLICT") {
      return { ok: false, status: 409, code: "IDEMPOTENCY_KEY_CONFLICT" };
    }
    if (accepted.status === 404) return { ok: false, status: 404, code: "SOURCE_CONNECTION_NOT_FOUND" };
    if (accepted.status === 422) return { ok: false, status: 422, code: "SOURCE_IMPORT_LIMIT_EXCEEDED" };
    return { ok: false, status: 409, code: "JOB_CONFLICT" };
  }

  return {
    ok: true,
    acceptance: {
      dataset: { id: accepted.datasetId, name: request.datasetName },
      job: {
        id: accepted.job.id,
        datasetId: accepted.datasetId,
        type: "IMPORT_DATASET",
        status: accepted.job.status,
      },
      progressPath: `/datasets/${accepted.datasetId}/imports/${accepted.job.id}`,
      reused: accepted.reused,
    },
    deliveryPending: accepted.deliveryPending,
  };
}
