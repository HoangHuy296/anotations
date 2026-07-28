import "server-only";

import { createHash } from "node:crypto";

import type { JobStatus, RepoProvider } from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import type { PreflightResult } from "@/lib/providers/provider.types";
import type { RepositoryImportRequest } from "@/lib/validation/repository-import-request";

export type SafeRepositoryImportJobInput = {
  source: {
    repository: {
      provider: "GITHUB" | "GITEA";
      owner: string;
      repo: string;
      ref: string;
      rootPath: string | null;
      visibility: "PUBLIC" | "PRIVATE";
    };
    manifest: {
      itemCount: number;
      declaredBytes: number;
      durationMs?: number;
    };
    sourceConnectionId: string | null;
  };
};

export type RepositoryImportAcceptance = {
  dataset: { id: string; name: string };
  job: { id: string; datasetId: string; type: "IMPORT_DATASET"; status: JobStatus };
  progressPath: string;
  reused: boolean;
};

/**
 * The durable Dataset uniqueness constraint is the authority for first-submit
 * idempotency. This small pure reconciliation step is intentionally shared by
 * the serializable transaction and its unique-conflict recovery path.
 */
export type DatasetCreationIdempotencyRecord<TJob> = {
  creationRequestHash: string | null;
  job: TJob | null;
};

export type DatasetCreationIdempotencyResolution<TJob> =
  | { kind: "absent" }
  | { kind: "conflict" }
  | { kind: "reused"; job: TJob };

export function reconcileDatasetCreationIdempotency<TJob>(
  existing: DatasetCreationIdempotencyRecord<TJob> | null,
  requestHash: string,
): DatasetCreationIdempotencyResolution<TJob> {
  if (!existing) return { kind: "absent" };
  // A Dataset row carrying an idempotency key without its matching Job is an
  // invariant violation. It must never cause a replacement Job to be made.
  if (existing.creationRequestHash !== requestHash || !existing.job) {
    return { kind: "conflict" };
  }
  return { kind: "reused", job: existing.job };
}

export type RepositoryImportAcceptanceInput = {
  actor: RequestActor;
  request: RepositoryImportRequest;
  preflight: PreflightResult;
  normalizedRootPath: string | null;
};

/**
 * Canonicalizes the user-intended request, not a mutable provider response.
 * The owner is scoped by the Dataset unique constraint, while the hash detects
 * a reuse of one key for a different request without storing sensitive data.
 */
export function creationRequestHash(
  input: RepositoryImportRequest,
  normalizedRootPath: string | null,
  normalizedServerUrl: string | null = null,
) {
  const canonical = JSON.stringify({
    version: 1,
    provider: input.provider,
    owner: input.repository.owner.trim().toLowerCase(),
    name: input.repository.name.trim().toLowerCase(),
    ref: input.repository.ref.trim(),
    rootPath: normalizedRootPath,
    expectedVisibility: input.repository.expectedVisibility,
    credentialMode: input.credentialMode,
    sourceConnectionId: input.credentialMode === "EXISTING_SOURCE_CONNECTION" ? input.sourceConnectionId ?? null : null,
    serverUrl: input.credentialMode === "EXISTING_SOURCE_CONNECTION" ? null : normalizedServerUrl,
    // A name is safe identity metadata. The PAT is intentionally omitted.
    connectionName: input.credentialMode === "ONE_TIME_PAT" ? input.connectionName?.trim() ?? null : null,
    datasetName: input.datasetName.trim(),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** The only data allowed into `Job.input` for Phase 015. */
export function buildSafeRepositoryImportJobInput(
  input: {
    provider: "GITHUB" | "GITEA";
    owner: string;
    repo: string;
    ref: string;
    normalizedRootPath: string | null;
    visibility: "PUBLIC" | "PRIVATE";
    sourceConnectionId: string | null;
    manifest: { itemCount: number; declaredBytes: number; durationMs?: number };
  },
): SafeRepositoryImportJobInput {
  return {
    source: {
      repository: {
        provider: input.provider,
        owner: input.owner.trim(),
        repo: input.repo.trim(),
        ref: input.ref.trim(),
        rootPath: input.normalizedRootPath,
        visibility: input.visibility,
      },
      manifest: input.manifest.durationMs === undefined
        ? { itemCount: input.manifest.itemCount, declaredBytes: input.manifest.declaredBytes }
        : input.manifest,
      sourceConnectionId: input.sourceConnectionId,
    },
  };
}

export function isSafeRepositoryImportJobInput(value: unknown): value is SafeRepositoryImportJobInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = (value as { source?: unknown }).source;
  if (!source || typeof source !== "object" || Array.isArray(source)) return false;
  const repository = (source as { repository?: unknown }).repository;
  if (!repository || typeof repository !== "object" || Array.isArray(repository)) return false;
  const manifest = (source as { manifest?: unknown }).manifest;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return false;
  const allowedSource = new Set(["repository", "manifest", "sourceConnectionId"]);
  const allowedRepository = new Set(["provider", "owner", "repo", "ref", "rootPath", "visibility"]);
  const allowedManifest = new Set(["itemCount", "declaredBytes", "durationMs"]);
  const isNonEmptySafeString = (candidate: unknown) => typeof candidate === "string"
    && candidate.trim().length > 0
    && !/[\u0000-\u001f]/.test(candidate);
  const validManifest = typeof (manifest as { itemCount?: unknown }).itemCount === "number"
    && Number.isSafeInteger((manifest as { itemCount: number }).itemCount)
    && (manifest as { itemCount: number }).itemCount >= 0
    && typeof (manifest as { declaredBytes?: unknown }).declaredBytes === "number"
    && Number.isSafeInteger((manifest as { declaredBytes: number }).declaredBytes)
    && (manifest as { declaredBytes: number }).declaredBytes >= 0
    && ((manifest as { durationMs?: unknown }).durationMs === undefined
      || (typeof (manifest as { durationMs?: unknown }).durationMs === "number"
        && Number.isSafeInteger((manifest as { durationMs: number }).durationMs)
        && (manifest as { durationMs: number }).durationMs >= 0));
  const repositoryValue = repository as Record<string, unknown>;
  const sourceValue = source as Record<string, unknown>;
  return Object.keys(value).length === 1
    && Object.keys(value)[0] === "source"
    && Object.keys(sourceValue).length === 3
    && Object.keys(sourceValue).every((key) => allowedSource.has(key))
    && Object.keys(repositoryValue).length === 6
    && Object.keys(repositoryValue).every((key) => allowedRepository.has(key))
    && (Object.keys(manifest).length === 2 || Object.keys(manifest).length === 3)
    && Object.keys(manifest).every((key) => allowedManifest.has(key))
    && (repositoryValue.provider === "GITHUB" || repositoryValue.provider === "GITEA")
    && isNonEmptySafeString(repositoryValue.owner)
    && isNonEmptySafeString(repositoryValue.repo)
    && isNonEmptySafeString(repositoryValue.ref)
    && (repositoryValue.rootPath === null || (typeof repositoryValue.rootPath === "string" && !/[\u0000-\u001f]/.test(repositoryValue.rootPath)))
    && (repositoryValue.visibility === "PUBLIC" || repositoryValue.visibility === "PRIVATE")
    && (sourceValue.sourceConnectionId === null || isNonEmptySafeString(sourceValue.sourceConnectionId))
    && validManifest;
}

export function repositoryProvider(value: "GITHUB" | "GITEA"): RepoProvider {
  return value;
}
